// Autoplay - the game playing itself.
//
// Same climber the Selenium bot (bot.py) drives, living in the page so it can
// also be switched on from the admin console with `autoplay on`. It only ever
// produces the inputs a player produces - w, space and a look angle, swung at a
// human turn rate - and it reads only what the server already broadcasts to
// this client. No teleporting, no altered physics.
//
// The client wires it up: setLevel/setMe/onState/onResult feed it, and
// Autoplay.transmit is the callback it sends its inputs through.
(function () {
  var AP = window.Autoplay = {};
  var B = AP;                                          // internal shorthand

  // Mirrored from levels.js. Nothing here is applied to the player - the server
  // owns the physics - they only let the bot predict where an arc comes down.
  var SPEED = 0.1, JUMP_V = 0.28, GRAV = 0.015, TERMINAL = -0.4;
  var HALF_H = 1;                                      // PLAYER_SIZE.height / 2
  var TICK_MS = 1000 / 60;
  var WIN_Y = 57;                                      // server's WIN_HEIGHT

  function newStatus() {
    return {
      mode: 'idle', step: -1, target: -1, maxY: 0, y: 0, done: false, ok: false,
      reason: null, note: '', fails: {}, jumps: 0, falls: 0, voids: 0, stuckAt: null, noWindow: null,
      ghost: false, startedAt: 0, lastProgressAt: 0
    };
  }

  AP.myId = null; AP.level = null; AP.path = []; AP.phase = null; AP.roomKind = null;
  AP.players = {}; AP.platforms = {}; AP.lavaY = null; AP.roundMsLeft = null;
  AP.result = null; AP.hist = []; AP.stateCount = 0; AP.running = false; AP.timer = null;
  AP.cfg = { maxAttempts: 4, stallMs: 90000, turnRate: 0.09, lagTicks: 2 };  // rad/tick, ticks
  AP.S = newStatus();

  // Supplied by the client: transmit(keys, angleY) puts an input on the wire,
  // requestStartRound() asks the server to start a round, log(text) prints to
  // the admin console.
  AP.transmit = null;
  AP.requestStartRound = null;
  AP.log = null;

  // Positions arrive one network hop late and inputs act one hop later still,
  // so every prediction is made that many ticks ahead. Locally that's ~2 ticks;
  // against a hosted server it can be 10+, which is the difference between
  // landing on a moving platform and landing where it used to be.
  B.measureLag = function () {
    var samples = [];
    function once(n) {
      var t0 = performance.now();
      return fetch(location.href, { method: 'HEAD', cache: 'no-store' })
        .then(function () {
          samples.push(performance.now() - t0);
          if (n > 1) return once(n - 1);
        })
        .catch(function () {});
    }
    return once(3).then(function () {
      if (!samples.length) return B.cfg.lagTicks;
      samples.sort(function (a, b) { return a - b; });
      var rtt = samples[Math.floor(samples.length / 2)];
      B.rttMs = rtt;
      B.cfg.lagTicks = Math.max(2, Math.min(20, Math.round(rtt / 2 / TICK_MS) + 2));
      return B.cfg.lagTicks;
    });
  };

  // ---- level bookkeeping -------------------------------------------------
  // level = [4 walls, ...path in climb order, ...kill hazards]; objects[] on
  // the server is the same list with the ground prepended, so a level index i
  // is object index i+1 - that's how moving platforms are matched to the live
  // positions in the 'state' broadcast.
  function setLevel(lvl) {
    B.level = lvl;
    var path = [];
    for (var i = 0; i < lvl.length; i++) {
      var p = lvl[i];
      if (i < 4 || p.special === 'kill') continue;
      p.__oi = i + 1;
      path.push(p);
    }
    B.path = path;
  }

  function livePos(p) {
    if (p.special === 'moving') {
      var q = B.platforms[p.__oi];
      if (q) return { x: q.x, y: q.y, z: q.z };
      return { x: p.startPos.x, y: p.startPos.y, z: p.startPos.z };
    }
    return { x: p.x, y: p.y, z: p.z };
  }

  function topOf(p) {                                  // mirrors towers.js topY()
    var q = livePos(p);
    if (p.shape === 'sphere' || p.shape === 'cylinder') return q.y + p.radius;
    return q.y + (p.height || 0.5) / 2;
  }

  function standY(p) { return topOf(p) + HALF_H; }      // player centre when stood on p

  function halfSpan(p) {
    if (p.shape === 'sphere') return p.radius;
    if (p.shape === 'cylinder') return Math.max(p.radius, (p.length || 1) / 2);
    if (p.shape === 'triangle') return (p.size || 1) / 2;
    return Math.max(p.width || 1, p.depth || 1) / 2;
  }

  function rangeLen(p) {
    return Math.hypot(p.endPos.x - p.startPos.x, p.endPos.z - p.startPos.z) || 1;
  }
  function atPoint(p, pt) {                            // is a moving platform at one end of its run?
    var q = livePos(p);
    return Math.hypot(q.x - pt.x, q.z - pt.z) <= Math.max(0.2, 0.1 * rangeLen(p));
  }

  // Every moving platform in a room advances in lockstep (moveT starts at 0 for
  // all of them and ticks at the same rate), so their phase can be read off
  // their live position and replayed forward with the server's own bounce rule.
  B.mv = {};
  function trackMoving() {
    for (var i = 0; i < B.path.length; i++) {
      var p = B.path[i];
      if (p.special !== 'moving') continue;
      var q = B.platforms[p.__oi];
      if (!q) continue;
      var t = Math.hypot(q.x - p.startPos.x, q.z - p.startPos.z) / rangeLen(p);
      var st = B.mv[p.__oi];
      var dir = st ? st.dir : 1;
      if (st) {
        if (t > st.t + 0.002) dir = 1;
        else if (t < st.t - 0.002) dir = -1;
      }
      B.mv[p.__oi] = { t: Math.min(1, Math.max(0, t)), dir: dir };
    }
  }

  // Where a platform will be in `ticks` ticks - mirrors advanceMovingPlatforms.
  function predict(p, ticks) {
    if (p.special !== 'moving') return { x: p.x, y: p.y, z: p.z };
    var st = B.mv[p.__oi];
    if (!st) return { x: p.startPos.x, y: p.startPos.y, z: p.startPos.z };
    var tt = st.t, dd = st.dir;
    for (var i = 0; i < ticks; i++) {
      tt += 0.01 * dd;
      if (tt >= 1) { tt = 1; dd = -1; }
      else if (tt <= 0) { tt = 0; dd = 1; }
    }
    return {
      x: p.startPos.x + (p.endPos.x - p.startPos.x) * tt,
      y: p.startPos.y + (p.endPos.y - p.startPos.y) * tt,
      z: p.startPos.z + (p.endPos.z - p.startPos.z) * tt
    };
  }

  function standingIndex(me) {
    var best = -1, bestD = 1e9;
    for (var i = 0; i < B.path.length; i++) {
      var p = B.path[i], q = livePos(p);
      if (Math.abs(me.y - standY(p)) > 0.4) continue;
      var d = Math.hypot(me.x - q.x, me.z - q.z);
      if (d > halfSpan(p) + 0.7) continue;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function onFloor(me) { return Math.abs(me.y - 1) < 0.35; }

  function ySteady() {
    if (B.hist.length < 4) return false;
    var h = B.hist.slice(-4), mn = Infinity, mx = -Infinity;
    for (var i = 0; i < h.length; i++) { mn = Math.min(mn, h[i]); mx = Math.max(mx, h[i]); }
    return (mx - mn) < 0.02;
  }

  // Ticks a jump spends in the air before falling back to a platform `dy`
  // above (or below) the take-off surface - same integration order as
  // resolveMovement, so it stays in step with the server.
  function airTicks(dy) {
    var v = JUMP_V, y = 0, t = 0;
    while (t < 400) {
      v -= GRAV;
      if (v < TERMINAL) v = TERMINAL;
      y += v; t++;
      if (v < 0 && y <= dy) break;                     // only on the way back down
    }
    return t;
  }

  // The part of a platform's top a landing can actually be trusted to stick to.
  function footprint(p) {
    if (p.shape === 'sphere') return { x: p.radius * 0.7, z: p.radius * 0.7 };
    if (p.shape === 'cylinder') {
      return p.axis === 'x'
        ? { x: (p.length / 2) * 0.8, z: p.radius * 0.7 }
        : { x: p.radius * 0.7, z: (p.length / 2) * 0.8 };
    }
    if (p.shape === 'triangle') return { x: (p.size / 2) * 0.6, z: (p.size / 2) * 0.6 };
    return { x: (p.width / 2) * 0.8, z: (p.depth / 2) * 0.8 };
  }

  function topAt(p, q) {
    if (p.shape === 'sphere' || p.shape === 'cylinder') return q.y + p.radius;
    return q.y + (p.height || 0.5) / 2;
  }

  // Fly the jump arc forward (w held, one direction, no steering - exactly what
  // the bot can actually do) and report the tick it comes down on `target`, or
  // -1. Against a moving platform this is much less restrictive than "land at
  // the arc's distance": the platform slides underneath the falling player, so
  // the reachable set is a window in time, not a ring in space.
  function arcLandsOn(me, dir, target) {
    var v = JUMP_V, y = 0;
    var fp = footprint(target);
    for (var t = 1; t <= 70; t++) {
      v -= GRAV;
      if (v < TERMINAL) v = TERMINAL;
      y += v;
      if (v >= 0) continue;                            // landings only happen coming down
      var q = predict(target, t + B.cfg.lagTicks);
      var feet = me.y - HALF_H + y;
      var top = topAt(target, q);
      if (feet > top + 0.3 || feet < top - 0.45) continue;
      var px = me.x + dir.x * SPEED * t, pz = me.z + dir.z * SPEED * t;
      if (Math.abs(px - q.x) <= fp.x && Math.abs(pz - q.z) <= fp.z) return t;
    }
    return -1;
  }

  // Try aiming at where the platform will be at a spread of arrival times and
  // take the first heading whose arc actually comes down on it.
  function planTimedJump(me, target) {
    for (var lead = 16; lead <= 50; lead += 2) {
      var q = predict(target, lead + B.cfg.lagTicks);
      var dx = q.x - me.x, dz = q.z - me.z;
      var d = Math.hypot(dx, dz);
      if (d < 0.001) continue;
      var dir = { x: dx / d, z: dz / d };
      var t = arcLandsOn(me, dir, target);
      if (t > 0) return { dir: dir, ticks: t, aim: q };
    }
    return null;
  }

  // ---- input -------------------------------------------------------------
  var keysOut = { w: false, a: false, s: false, d: false, jump: false, down: false };
  var angOut = 0;
  var curAng = 0;

  function normAng(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  // The look angle is swung at a fixed rate rather than set outright: snapping
  // it steers the player instantly and reads as teleporting. Turning takes
  // time, so the bot turns on the spot and only commits to a jump once it is
  // actually facing where it means to go - the arc still leaves at exactly the
  // heading the tower was verified with.
  function turnToward(target) {
    var d = normAng(target - curAng);
    var step = B.cfg.turnRate;
    if (Math.abs(d) <= step) curAng = target;
    else curAng += (d > 0 ? step : -step);
    curAng = normAng(curAng);
    return Math.abs(normAng(target - curAng));
  }
  function aligned(target) { return Math.abs(normAng(target - curAng)) < 0.02; }

  function send(w, jump, ang) {
    keysOut.w = !!w; keysOut.jump = !!jump;
    if (typeof ang === 'number') turnToward(ang);
    angOut = curAng;
    if (AP.transmit) AP.transmit(keysOut, angOut);
  }
  function idle() { send(false, false, angOut); }

  // Facing that makes `w` walk straight at `to`: forward is (-sin a, -cos a).
  function faceAngle(from, to) {
    var dx = to.x - from.x, dz = to.z - from.z;
    var d = Math.hypot(dx, dz) || 1;
    return Math.atan2(-dx / d, -dz / d);
  }

  // Walk to a point and stop on it. State arrives at 30 Hz, so holding w to
  // the last centimetre overshoots; past 0.45 units it holds w, inside that
  // it taps w in ~1-tick pulses and re-reads the position between taps.
  var appr = { pulses: 0, pulseT: 0, on: false };
  function resetApproach() { appr.pulses = 0; appr.pulseT = 0; appr.on = false; }

  // Returns true once it has arrived - and then deliberately sends nothing, so
  // the caller owns the heading from that point on. Two send() calls in one
  // tick means two turn steps pulling opposite ways, which never settles.
  function approach(me, tgt, tol) {
    var d = Math.hypot(tgt.x - me.x, tgt.z - me.z);
    var ang = faceAngle(me, tgt);
    if (d <= tol) return true;
    if (d > 0.45) { resetApproach(); send(true, false, ang); return false; }
    var t = performance.now();
    if (t - appr.pulseT > 70) { appr.pulseT = t; appr.on = true; appr.pulses++; }
    else if (appr.on && t - appr.pulseT > 25) { appr.on = false; }
    if (appr.pulses > 20) return true;                 // close enough; stop fiddling
    send(appr.on, false, ang);
    return false;
  }

  // ---- fed by the client ------------------------------------------------
  AP.setLevel = function (lvl) { setLevel(lvl); };
  AP.setMe = function (id, roomKind) { AP.myId = id; AP.roomKind = roomKind; };
  AP.setPhase = function (phase) { AP.phase = phase; };
  AP.onResult = function (msg) { AP.result = { winner: msg.winner, secondsLeft: msg.secondsLeft }; };

  AP.onState = function (m) {
    AP.players = m.players; AP.platforms = m.platforms; AP.phase = m.phase;
    AP.lavaY = m.gimmick ? m.gimmick.lavaY : null;
    AP.roundMsLeft = m.roundMsLeft;
    AP.stateAt = performance.now();
    AP.stateCount++;
    trackMoving();
    var me = m.players[AP.myId];
    if (me) { AP.hist.push(me.y); if (AP.hist.length > 8) AP.hist.shift(); }
  };

  // ---- climb state machine ----------------------------------------------
  var J = { tJump: 0, angle: 0, estMs: 0, waitT: 0, walkT: 0, ringIdx: 0, sideIdx: 0, mountT: 0, lastD: null };

  function finish(ok, reason) {
    var S = B.S;
    S.done = true; S.ok = ok; S.reason = reason; S.mode = 'done';
    B.running = false;
    idle();
  }

  function progress(note) {
    B.S.lastProgressAt = performance.now();
    B.S.note = note || B.S.note;
  }

  function enterWalk(i) {
    B.S.step = i; B.S.mode = 'walk'; resetApproach();
    J.walkT = performance.now();
  }

  function failStep(landedIdx) {
    var S = B.S;
    S.falls++;
    var key = String(S.target);
    S.fails[key] = (S.fails[key] || 0) + 1;
    if (S.target === 0) J.sideIdx = (J.sideIdx || 0) + 1;
    if (S.fails[key] >= B.cfg.maxAttempts) {
      S.stuckAt = S.target;
      finish(false, 'stuck');
      return;
    }
    if (landedIdx >= 0) enterWalk(landedIdx);
    else { S.mode = 'locate'; S.step = -1; }
  }

  function tick() {
    if (!B.running) return;
    var S = B.S;
    var me = B.players[B.myId];
    if (!me || !B.path.length) return;

    if (me.y > S.maxY) S.maxY = me.y;
    S.y = me.y;
    S.ghost = !!me.ghost;

    if (B.result) {                                    // round decided by the server
      if (B.result.winner === B.myId) { finish(true, 'won'); return; }
      if (B.roomKind === 'main' && B.result.winner !== null) { finish(false, 'lost'); return; }
    }

    if (performance.now() - S.lastProgressAt > B.cfg.stallMs) { finish(false, 'stalled'); return; }

    // Clipping a platform's side mid-jump gets resolved as a ceiling hit, which
    // can push the player down into the ground and out of the world. Nothing
    // respawns them (only lava does, and only in a live main-room round), so
    // the run is over - Python reloads the page and starts a fresh one.
    if (me.y < -15 && !me.ghost) { S.voids++; finish(false, 'void'); return; }

    // Main rooms need a round running, and being caught by lava/a meteor turns
    // you into a ghost who can't win - sit those out and go again next round.
    if (B.roomKind === 'main') {
      if (B.phase !== 'playing') {
        idle();
        S.mode = 'waiting-round'; S.step = -1;
        if (B.phase === 'waiting' && performance.now() - (B.lastStart || 0) > 1500) {
          B.lastStart = performance.now();
          if (AP.requestStartRound) AP.requestStartRound();
        }
        return;
      }
      if (me.ghost) { idle(); S.mode = 'ghost'; S.step = -1; return; }
      if (S.mode === 'waiting-round' || S.mode === 'ghost') { S.mode = 'locate'; progress('round live'); }
    }

    if (S.mode === 'idle') S.mode = 'locate';

    switch (S.mode) {

      // Work out where we are: on a path platform, on the floor, or still falling.
      case 'locate': {
        idle();
        if (!ySteady()) return;
        var i = standingIndex(me);
        if (i >= 0) { enterWalk(i); progress('on platform ' + i); }
        else if (onFloor(me)) {
          S.mode = 'mount'; S.step = -1; resetApproach();
          J.waitT = performance.now();
        }
        return;
      }

      // From the floor, hop onto the first platform: walk to a spot a jump's
      // length away from it, face it, jump.
      // From the floor, hop onto the first platform. Take off from where the
      // falling half of the arc crosses the platform's height (the relationship
      // jumpDescentDist() encodes in towers.js) and square up to a face, not a
      // corner: clipping the platform on the way up is resolved by the server as
      // a ceiling hit, which shoves the player down through the ground and out
      // of the world. A diagonal approach clips from any distance under ~3
      // units, an axis-aligned one is clear from ~1.6.
      //
      // Getting to that spot means circling at a fixed radius rather than
      // walking straight at it - the platform sits at head height, so a
      // straight line to the far side just walks into its underside and stops.
      case 'mount': {
        var first = B.path[0], c = livePos(first);
        var mDy = standY(first) - me.y;
        var R = airTicks(mDy) * SPEED + [0.2, 0.45, 0.05, 0.7][J.ringIdx % 4];
        var bx = me.x - c.x, bz = me.z - c.z, bl = Math.hypot(bx, bz) || 0.001;
        var theta = Math.atan2(bz, bx);
        var quarter = Math.PI / 2;
        var want = Math.round(theta / quarter) * quarter + (J.sideIdx || 0) * quarter;
        var dTheta = normAng(want - theta);

        if (Math.abs(bl - R) > 0.2) {                  // get onto the ring first
          var rp = { x: c.x + (bx / bl) * R, z: c.z + (bz / bl) * R };
          if (approach(me, rp, 0.15)) idle();
          return;
        }
        if (Math.abs(dTheta) > 0.08) {                 // then walk round it to a face
          var stepA = theta + (dTheta > 0 ? 1 : -1) * Math.min(Math.abs(dTheta), 0.3);
          var tp = { x: c.x + Math.cos(stepA) * R, z: c.z + Math.sin(stepA) * R };
          if (approach(me, tp, 0.1)) idle();
          return;
        }

        var mAim = faceAngle(me, { x: c.x, z: c.z });
        if (!aligned(mAim)) { send(false, false, mAim); return; }
        S.target = 0;
        J.angle = mAim;
        J.tJump = performance.now();
        J.estMs = airTicks(mDy) * TICK_MS;
        J.ringIdx++;
        S.jumps++;
        S.mode = 'air';
        return;
      }

      // Centre up on the platform we're standing on, then line up the jump.
      case 'walk': {
        var p = B.path[S.step];
        if (!p) { S.mode = 'locate'; return; }
        if (ySteady() && standingIndex(me) < 0) { S.mode = 'locate'; return; }
        if (p.special === 'moving') {
          var q = livePos(p);
          approach(me, { x: q.x, z: q.z }, 0.25);
          if (Math.hypot(me.x - q.x, me.z - q.z) < 0.45) { S.mode = 'ride'; J.waitT = performance.now(); }
          return;
        }
        // Standing on a sphere or a rail pins the player: the box rests exactly
        // tangent to the shape, so every horizontal step reads as a collision
        // and centring never finishes. Take off from wherever we are instead -
        // aiming at the next platform already cancels the sideways part of the
        // offset, and the retry logic covers the rest.
        var walked = approach(me, { x: p.x, z: p.z }, 0.15);
        if (walked) idle();
        if (walked || performance.now() - J.walkT > 2500) {
          if (!walked) S.note = 'jumped off-centre from platform ' + S.step;
          S.mode = 'prejump'; J.waitT = performance.now();
        }
        return;
      }

      // On a moving platform: hold the centre (the server carries riders with
      // the platform) and wait for it to reach endPos, which is the take-off
      // point every jump off it was verified from.
      case 'ride': {
        var mp = B.path[S.step];
        if (!mp || mp.special !== 'moving') { S.mode = 'walk'; return; }
        var mq = livePos(mp);
        var centred = approach(me, { x: mq.x, z: mq.z }, 0.2);
        if (centred) idle();
        if (centred || performance.now() - J.waitT > 3000) {
          S.mode = 'prejump'; J.waitT = performance.now();
        }
        return;
      }

      // Aim at the next platform's generated position (what the generator
      // verified against), and for a moving target wait until it's back at
      // startPos so the arc matches the verified one.
      case 'prejump': {
        var cur = B.path[S.step];
        var nxt = B.path[S.step + 1];
        if (!nxt) {                                    // standing on the top platform
          idle();
          if (B.roomKind === 'main') {
            if (me.y >= WIN_Y && performance.now() - J.waitT > 5000) finish(true, 'top-no-result');
            return;                                    // otherwise wait for round_result
          }
          finish(true, 'top');
          return;
        }
        // A jump's horizontal reach isn't a choice: for a given height
        // difference the arc lands at exactly one distance. Against a static
        // platform that distance is what the generator laid the tower out
        // with, so jump as soon as we're centred. Anything involving a moving
        // platform has to be timed instead - aim at where the platform will be
        // when the arc comes down, and wait for the moment that lands the
        // right distance away.
        var n = airTicks(standY(nxt) - me.y);
        var timed = nxt.special === 'moving' || (cur && cur.special === 'moving');
        var aim = { x: nxt.x, z: nxt.z };
        var flightTicks = n;

        if (timed) {
          var plan = planTimedJump(me, nxt);
          if (!plan) {
            if (cur && cur.special === 'moving') {
              var cq = livePos(cur);
              // hold the centre while we wait, and pre-aim once we're on it
              if (approach(me, { x: cq.x, z: cq.z }, 0.2)) {
                send(false, false, faceAngle(me, predict(nxt, 25)));
              }
            } else {
              send(false, false, faceAngle(me, predict(nxt, 25)));  // pre-aim at where it will be  // pre-aim while waiting
            }
            // Three full platform cycles with no workable moment: from here,
            // the arc never comes down on that platform at all.
            if (performance.now() - J.waitT > 12000) {
              S.target = S.step + 1;
              S.noWindow = S.step + 1;
              failStep(standingIndex(me));
            }
            return;
          }
          aim = { x: me.x + plan.dir.x, z: me.z + plan.dir.z };
          flightTicks = plan.ticks;
        }

        var jAim = faceAngle(me, aim);
        if (!aligned(jAim)) { send(false, false, jAim); return; }   // finish turning first

        S.target = S.step + 1;
        J.angle = jAim;
        J.tJump = performance.now();
        J.estMs = flightTicks * TICK_MS;
        S.jumps++;
        S.mode = 'air';
        return;
      }

      // w + space on the same tick (exactly what simulateJump verifies), w held
      // through the arc, released as we touch down so we don't walk off the far
      // edge of a 1-unit platform.
      case 'air': {
        var el = performance.now() - J.tJump;
        var holdW = el < J.estMs + 40;
        send(holdW, el < 70, J.angle);

        if (el > 400 && ySteady()) {
          var idx = standingIndex(me);
          if (idx >= 0) {
            idle();
            if (idx >= S.target) {
              S.fails[String(S.target)] = 0;
              enterWalk(idx);
              progress('reached platform ' + idx + ' of ' + (B.path.length - 1));
            } else {
              failStep(idx);
            }
            return;
          }
          if (onFloor(me)) { idle(); failStep(-1); return; }
        }
        if (el > 9000) { idle(); failStep(standingIndex(me)); }
        return;
      }
    }
  }

  // ---- public surface ----------------------------------------------------
  AP.isRunning = function () { return !!AP.running; };
  AP.currentInput = function () { return { keys: keysOut, angleY: angOut }; };

  AP.start = function (cfg) {
    if (cfg) for (var k in cfg) AP.cfg[k] = cfg[k];
    if (!AP.path.length) { if (AP.log) AP.log('autoplay: no level loaded yet'); return false; }
    AP.S = newStatus();
    AP.S.startedAt = performance.now();
    AP.S.lastProgressAt = performance.now();
    AP.S.mode = 'locate';
    AP.result = null;
    AP.running = true;
    if (!AP.timer) AP.timer = setInterval(tick, 16);
    if (AP.log) AP.log('autoplay ON - ' + AP.path.length + ' platforms to the top');
    return true;
  };

  AP.stop = function () {
    var was = AP.running;
    AP.running = false;
    keysOut.w = keysOut.jump = false;
    if (AP.transmit) AP.transmit(keysOut, angOut);
    if (was && AP.log) AP.log('autoplay OFF');
  };

  AP.toggle = function (cfg) { return AP.running ? (AP.stop(), false) : AP.start(cfg); };

  AP.dbg = function () { return { ang: curAng, appr: appr, J: J, cfg: B.cfg }; };

  AP.status = function () {
    var S = B.S;
    return {
      mode: S.mode, step: S.step, target: S.target, steps: B.path.length - 1,
      y: S.y, maxY: S.maxY, done: S.done, ok: S.ok, reason: S.reason, note: S.note,
      jumps: S.jumps, falls: S.falls, voids: S.voids, fails: S.fails,
      stuckAt: S.stuckAt, noWindow: S.noWindow, ghost: S.ghost,
      phase: B.phase, roomKind: B.roomKind, roomId: B.roomId, myId: B.myId,
      pathLen: B.path.length, stateCount: B.stateCount, lavaY: B.lavaY,
      roundMsLeft: B.roundMsLeft, result: B.result,
      elapsed: (performance.now() - S.startedAt) / 1000
    };
  };

  // Where a stuck run gave up, in the tower's own coordinates.
  AP.stepInfo = function (i) {
    var a = B.path[i - 1], b = B.path[i];
    if (!a || !b) return null;
    return {
      index: i,
      from: { x: a.x, y: a.y, z: a.z, shape: a.shape || 'box', moving: a.special === 'moving' },
      to: { x: b.x, y: b.y, z: b.z, shape: b.shape || 'box', moving: b.special === 'moving' },
      dist: Math.hypot(b.x - a.x, b.z - a.z),
      dy: standY(b) - standY(a)
    };
  };
})();
