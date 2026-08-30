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
      reason: null, note: '', error: null, fails: {}, jumps: 0, falls: 0, voids: 0,
      stuckAt: null, noWindow: null, defers: 0, replans: 0, hops: 0, landings: [],
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
    var byObject = {};
    for (var i = 0; i < lvl.length; i++) {
      var p = lvl[i];
      if (i < 4 || p.special === 'kill') continue;
      p.__oi = i + 1;
      byObject[p.__oi] = path.length;
      path.push(p);
    }
    B.path = path;
    B.stepOfObject = byObject;
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

  // Which platform we are stood on. The horizontal window has to allow for
  // landing right on the lip - the player only needs its box to overlap, so it
  // can rest up to half its own width past the edge, and a landing the bot
  // can't name is a landing it throws away.
  function standingIndex(me) {
    var best = -1, bestD = 1e9;
    for (var i = 0; i < B.path.length; i++) {
      var p = B.path[i], q = livePos(p);
      if (Math.abs(me.y - standY(p)) > 0.4) continue;
      var d = Math.hypot(me.x - q.x, me.z - q.z);
      if (d > halfSpan(p) + 1.1) continue;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function onFloor(me) { return Math.abs(me.y - 1) < 0.35; }

  // Four samples, not three: three can go steady around the apex of a jump,
  // where the player is barely moving vertically, and the bot then decides it
  // has landed while it is still in the air.
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

  // Fly the jump arc forward (w held, one heading, no steering - exactly what
  // the bot can actually do) from `pos`, launched `t0` ticks from now, and
  // report the tick it comes down on `target`, or -1. Against a moving platform
  // this is far less restrictive than "land at the arc's distance": the
  // platform slides underneath the falling player, so what is reachable is a
  // window in time, not a ring in space.
  function arcLandsAt(pos, dir, target, t0) {
    var v = JUMP_V, y = 0;
    var fp = footprint(target);
    for (var t = 1; t <= 70; t++) {
      v -= GRAV;
      if (v < TERMINAL) v = TERMINAL;
      y += v;
      if (v >= 0) continue;                            // landings only happen coming down
      var q = predict(target, t0 + t);
      var feet = pos.y - HALF_H + y;
      var top = topAt(target, q);
      if (feet > top + 0.3 || feet < top - 0.45) continue;
      var px = pos.x + dir.x * SPEED * t, pz = pos.z + dir.z * SPEED * t;
      if (Math.abs(px - q.x) <= fp.x && Math.abs(pz - q.z) <= fp.z) return t;
    }
    return -1;
  }

  // Riding a platform carries the player with it, so where we will be in
  // `ticks` ticks is exactly as predictable as where the platform will be.
  function predictSelf(me, cur, ticks) {
    if (!cur || cur.special !== 'moving') return { x: me.x, y: me.y, z: me.z };
    var here = livePos(cur), later = predict(cur, ticks);
    return { x: me.x + (later.x - here.x), y: me.y + (later.y - here.y), z: me.z + (later.z - here.z) };
  }

  // Decide *when* to jump, not just whether a jump works right now.
  //
  // Re-deciding every tick is what broke jumps off moving platforms: the ride
  // keeps moving the player, so the answer kept changing, and with the view
  // swinging at a human rate the bot could never finish turning to any of them.
  // Here the whole take-off is settled up front - the moment, the heading and
  // the flight time - leaving the bot to hold that heading and press space on
  // the tick it picked.
  //
  // Both platforms repeat on the same cycle, so one cycle of candidate moments
  // is exhaustive: if none of them land, none ever will from this spot.
  var PLAN_HORIZON = 220;                              // ticks - a full platform cycle plus slack
  var LEADS = [20, 26, 32, 38, 44, 50];                // how far ahead of the platform to aim
  var PLAN_FAN = [0, 0.07, -0.07, 0.15, -0.15, 0.25, -0.25];
  // Nudges tried around a heading: AIM_FAN when lining up a jump, FIRE_FAN in
  // the instant before taking off.
  var AIM_FAN = [0, 0.04, -0.04, 0.08, -0.08, 0.14, -0.14, 0.22, -0.22, 0.34, -0.34, 0.5, -0.5];
  var FIRE_FAN = [0, 0.05, -0.05, 0.1, -0.1];

  function planTakeoff(me, cur, nxt, minStep) {
    var lag = B.cfg.lagTicks;

    for (var t0 = 0; t0 <= PLAN_HORIZON; t0 += 4) {
      var pos = predictSelf(me, cur, t0 + lag);
      for (var li = 0; li < LEADS.length; li++) {
        var q = predict(nxt, t0 + lag + LEADS[li]);
        var dx = q.x - pos.x, dz = q.z - pos.z;
        var d = Math.hypot(dx, dz);
        if (d < 0.001) continue;
        var base = Math.atan2(-dx / d, -dz / d);
        // Aiming straight at where the platform will be is only a starting
        // guess; a couple of degrees either side often makes the difference.
        // No use picking a moment we cannot be facing the right way by.
        if (Math.abs(normAng(base - curAng)) / B.cfg.turnRate + 2 > t0) continue;
        var hit = bestJump(pos, base, PLAN_FAN, t0 + lag, minStep);
        if (hit) return { at: t0, angle: hit.angle, ticks: hit.ticks, step: hit.step };
      }
    }
    return null;
  }

  // How close a straight walk from `a` to `b` comes to `p`.
  function segmentDistance(a, b, p) {
    var vx = b.x - a.x, vz = b.z - a.z;
    var len2 = vx * vx + vz * vz;
    var t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / len2)) : 0;
    return Math.hypot(a.x + vx * t - p.x, a.z + vz * t - p.z);
  }

  // Where to stand to hop onto the first platform: one of its four faces, at
  // the distance the arc actually comes down from. Candidates have to survive
  // the engine's own simulation, and the walk to them has to stay clear of the
  // platform - it sits at head height, and walking under it just stops you.
  function planMount(me, first) {
    var c = livePos(first);
    var R = airTicks(standY(first) - me.y) * SPEED + 0.2;
    var clear = halfSpan(first) + 0.9;
    var best = null;
    for (var k = 0; k < 4; k++) {
      var a = k * Math.PI / 2;
      var pt = { x: c.x + Math.cos(a) * R, y: me.y, z: c.z + Math.sin(a) * R };
      if (segmentDistance(me, pt, c) < clear) continue;          // would walk under it
      if (simulateJump(pt, faceAngle(pt, c), first.__oi, 0) < 0) continue;
      var cost = Math.hypot(pt.x - me.x, pt.z - me.z);
      if (J.mountAvoid && Math.hypot(pt.x - J.mountAvoid.x, pt.z - J.mountAvoid.z) < 0.5) cost += 100;
      if (!best || cost < best.cost) best = { pt: pt, cost: cost };
    }
    return best ? best.pt : null;
  }

  // ---- a local copy of the server's physics ------------------------------
  // The analytic arc above is a good filter but a poor judge: it agrees with
  // the engine only about half the time, because "am I roughly over the
  // platform at roughly its height" is not the landing rule. The real rule is
  // shape-aware collision plus a ledge test, and it decides whether a jump onto
  // a moving platform works. So the bot runs the engine's own maths on the
  // level it has been sent, and only commits to a take-off it has simulated.
  // Mirrors physics.js - if that changes, this has to change with it.
  var SIZE = { width: 1, height: 2, depth: 1 };
  var GROUND = { position: { x: 0, y: -0.5, z: 0 }, width: 40, height: 1, depth: 40 };

  function collideBox(posA, sizeA, posB, sizeB) {
    return Math.abs(posA.x - posB.x) < (sizeA.width + sizeB.width) / 2 &&
           Math.abs(posA.y - posB.y) < (sizeA.height + sizeB.height) / 2 &&
           Math.abs(posA.z - posB.z) < (sizeA.depth + sizeB.depth) / 2;
  }

  // Matches physics.js: resting exactly on top of a shape is not a collision.
  var TOUCH_EPS = 1e-6;

  function collideSphere(sc, r, bp, bs) {
    var cx = Math.max(bp.x - bs.width / 2, Math.min(sc.x, bp.x + bs.width / 2));
    var cy = Math.max(bp.y - bs.height / 2, Math.min(sc.y, bp.y + bs.height / 2));
    var cz = Math.max(bp.z - bs.depth / 2, Math.min(sc.z, bp.z + bs.depth / 2));
    var dx = sc.x - cx, dy = sc.y - cy, dz = sc.z - cz;
    return (dx * dx + dy * dy + dz * dz) < r * r - TOUCH_EPS;
  }

  function collideCylinder(cp, r, len, axis, bp, bs) {
    var half = len / 2;
    var c = { x: cp.x, y: cp.y, z: cp.z };
    if (axis === 'x') c.x = Math.max(cp.x - half, Math.min(bp.x, cp.x + half));
    else c.z = Math.max(cp.z - half, Math.min(bp.z, cp.z + half));
    return collideSphere(c, r, bp, bs);
  }

  function collideTriangle(tp, size, height, bp, bs) {
    if (bp.y + bs.height / 2 <= tp.y - height / 2 || bp.y - bs.height / 2 >= tp.y + height / 2) return false;
    var h = size * Math.sqrt(3) / 2;
    var tri = [
      { x: tp.x, z: tp.z - (2 / 3) * h },
      { x: tp.x - size / 2, z: tp.z + (1 / 3) * h },
      { x: tp.x + size / 2, z: tp.z + (1 / 3) * h },
    ];
    var hx = bs.width / 2, hz = bs.depth / 2;
    var box = [
      { x: bp.x - hx, z: bp.z - hz }, { x: bp.x + hx, z: bp.z - hz },
      { x: bp.x + hx, z: bp.z + hz }, { x: bp.x - hx, z: bp.z + hz },
    ];
    function overlaps(ax, az) {
      var amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity, i, pr;
      for (i = 0; i < tri.length; i++) { pr = tri[i].x * ax + tri[i].z * az; if (pr < amin) amin = pr; if (pr > amax) amax = pr; }
      for (i = 0; i < box.length; i++) { pr = box[i].x * ax + box[i].z * az; if (pr < bmin) bmin = pr; if (pr > bmax) bmax = pr; }
      return amax >= bmin && bmax >= amin;
    }
    if (!overlaps(1, 0) || !overlaps(0, 1)) return false;
    for (var i = 0; i < 3; i++) {
      var p1 = tri[i], p2 = tri[(i + 1) % 3];
      if (!overlaps(-(p2.z - p1.z), p2.x - p1.x)) return false;
    }
    return true;
  }

  function hitTest(o) {
    if (o.shape === 'sphere') return function (pos) { return collideSphere(o.position, o.radius, pos, SIZE); };
    if (o.shape === 'cylinder') return function (pos) { return collideCylinder(o.position, o.radius, o.length, o.axis || 'z', pos, SIZE); };
    if (o.shape === 'triangle') return function (pos) { return collideTriangle(o.position, o.size, o.height, pos, SIZE); };
    return function (pos) { return collideBox(pos, SIZE, o.position, { width: o.width, height: o.height, depth: o.depth }); };
  }

  // The level as the server holds it, with every moving platform wound forward
  // to where it will be `ticks` from now.
  function simWorld(ticks) {
    var objects = [GROUND];
    for (var i = 0; i < B.level.length; i++) {
      var p = B.level[i];
      var pos = p.special === 'moving' ? predict(p, ticks) : { x: p.x, y: p.y, z: p.z };
      var o = {
        position: { x: pos.x, y: pos.y, z: pos.z },
        shape: p.shape, width: p.width, height: p.height, depth: p.depth,
        radius: p.radius, length: p.length, size: p.size, axis: p.axis,
        special: p.special, index: i + 1,
      };
      if (p.special === 'moving') {
        var st = B.mv[p.__oi];
        var tt = st ? st.t : 0, dd = st ? st.dir : 1;
        for (var n = 0; n < ticks; n++) { tt += 0.01 * dd; if (tt >= 1) { tt = 1; dd = -1; } else if (tt <= 0) { tt = 0; dd = 1; } }
        o.moveT = tt; o.moveDir = dd; o.startPos = p.startPos; o.endPos = p.endPos;
      }
      objects.push(o);
    }
    return objects;
  }

  function advanceSim(objects) {
    for (var i = 0; i < objects.length; i++) {
      var o = objects[i];
      if (o.special !== 'moving') continue;
      o.moveT += 0.01 * o.moveDir;
      if (o.moveT >= 1) { o.moveT = 1; o.moveDir = -1; }
      else if (o.moveT <= 0) { o.moveT = 0; o.moveDir = 1; }
      o.position.x = o.startPos.x + (o.endPos.x - o.startPos.x) * o.moveT;
      o.position.y = o.startPos.y + (o.endPos.y - o.startPos.y) * o.moveT;
      o.position.z = o.startPos.z + (o.endPos.z - o.startPos.z) * o.moveT;
    }
  }

  // Jump from `pos` on heading `angle`, w held, `t0` ticks from now. Returns
  // {ticks, oi} for wherever it lands, or null if it dies or falls.
  function simulateJumpTo(pos, angle, t0) {
    var objects = simWorld(t0);
    var p = { x: pos.x, y: pos.y, z: pos.z };
    var yVel = 0, onGround = true;
    var fwd = { x: -Math.sin(angle), z: -Math.cos(angle) };

    for (var t = 0; t < 80; t++) {
      advanceSim(objects);
      var dx = fwd.x * SPEED, dz = fwd.z * SPEED;
      if (t === 0 && onGround) yVel = JUMP_V;
      yVel -= GRAV;
      if (yVel < TERMINAL) yVel = TERMINAL;
      var dy0 = yVel, dy = dy0;
      onGround = false;

      var bestLand = null, bestObj = null, bestCeil = null;
      for (var i = 0; i < objects.length; i++) {
        var o = objects[i];
        var top, bottom;
        if (o.shape === 'sphere' || o.shape === 'cylinder') { top = o.position.y + o.radius; bottom = o.position.y - o.radius; }
        else { top = o.position.y + o.height / 2; bottom = o.position.y - o.height / 2; }
        var hits = hitTest(o);

        if (hits({ x: p.x, y: p.y + dy0, z: p.z })) {
          var foot = p.y - SIZE.height / 2;
          if (yVel < 0 && top <= foot + 0.05) {
            var cand = top - foot;
            if (bestLand === null || cand > bestLand) { bestLand = cand; bestObj = o; }
          } else if (yVel >= 0) {
            var ceil = bottom - (p.y + SIZE.height / 2);
            if (bestCeil === null || ceil < bestCeil) bestCeil = ceil;
          }
        }
        if (dx !== 0 && hits({ x: p.x + dx, y: p.y, z: p.z })) dx = 0;
        if (dz !== 0 && hits({ x: p.x, y: p.y, z: p.z + dz })) dz = 0;
      }

      if (bestLand !== null) { onGround = true; dy = bestLand; yVel = 0; }
      else if (bestCeil !== null) { dy = bestCeil; yVel = 0; }

      var next = { x: p.x + dx, y: p.y + dy, z: p.z + dz };
      for (var k = 0; k < objects.length; k++) {
        if (objects[k].special === 'kill' && hitTest(objects[k])(next)) return -1;
      }
      p = next;

      if (onGround && t > 2) {
        return bestObj
          ? { ticks: t, oi: bestObj.index, at: { x: p.x, z: p.z }, obj: bestObj }
          : null;
      }
      if (p.y < pos.y - 20) return null;
    }
    return null;
  }

  // Any landing that gets us further up the climb counts, not just the very
  // next platform: a jump that carries two steps at once is a jump the bot
  // used to throw away, and from an awkward spot it is sometimes the only one
  // that works at all.
  // How much further the bot could walk after touching down before it runs out
  // of platform. It always overshoots the simulated landing by a couple of
  // ticks — it has to guess the landing moment in wall-clock time, and letting
  // go early lands short instead — so a landing on the lip is a fall waiting to
  // happen, and one with room to spare is not.
  function landingMargin(landing, angle) {
    var p = B.path[B.stepOfObject[landing.oi]];
    if (!p) return 0;
    // The player stays up while its box overlaps the platform, so the ground
    // it can stand on reaches half a player width past the platform's edge.
    var fp = footprint(p);
    fp = { x: fp.x + 0.45, z: fp.z + 0.45 };
    var c = landing.obj.position;
    var fwd = { x: -Math.sin(angle), z: -Math.cos(angle) };
    var room = Infinity;
    if (Math.abs(fwd.x) > 0.001) room = Math.min(room, (fp.x - (landing.at.x - c.x) * Math.sign(fwd.x)) / Math.abs(fwd.x));
    if (Math.abs(fwd.z) > 0.001) room = Math.min(room, (fp.z - (landing.at.z - c.z) * Math.sign(fwd.z)) / Math.abs(fwd.z));
    return room;
  }

  function evaluateJump(pos, angle, t0, minStep) {
    var landing = simulateJumpTo(pos, angle, t0);
    if (!landing) return null;
    var step = B.stepOfObject[landing.oi];
    if (step === undefined || step < minStep) return null;
    return { ticks: landing.ticks, step: step, margin: landingMargin(landing, angle) };
  }

  // First heading in the fan that lands. The fan starts at "straight at the
  // platform", which is the heading the tower was laid out around, and widens
  // from there — preferring a different one because it scores better on a
  // margin estimate made things worse, not better.
  function bestJump(pos, baseAngle, fan, t0, minStep) {
    for (var i = 0; i < fan.length; i++) {
      var ang = baseAngle + fan[i];
      var hit = evaluateJump(pos, ang, t0, minStep);
      if (hit) { hit.angle = ang; return hit; }
    }
    return null;
  }

  // Back-compat helper for the single-target checks (the mount).
  function simulateJump(pos, angle, targetOi, t0) {
    var landing = simulateJumpTo(pos, angle, t0);
    return landing && landing.oi === targetOi ? landing.ticks : -1;
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
  var J = { tJump: 0, angle: 0, estMs: 0, waitT: 0, walkT: 0, plan: null, planAt: 0, mountPt: null, mountUsed: null, mountAvoid: null };

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

  // Standing on a sphere, a rail or a triangle pins the player: the box rests
  // exactly tangent to the shape, so every step registers as a collision and
  // the bot cannot walk to a better spot. Hopping works, though — you're free
  // to move in mid-air — so a little hop towards the middle is the way out of
  // a spot no jump works from. It's an ordinary jump whose target is the
  // platform we're already on.
  function hopTowards(me, p) {
    var c = livePos(p);
    var d = Math.hypot(c.x - me.x, c.z - me.z);
    if (d < 0.05) return false;
    B.S.target = B.S.step;
    J.angle = faceAngle(me, { x: c.x, z: c.z });
    J.tJump = performance.now();
    J.estMs = Math.min(Math.round(d / SPEED), 9) * TICK_MS;
    J.hops++;
    B.S.hops++;
    B.S.jumps++;
    B.S.mode = 'air';
    return true;
  }

  function enterWalk(i) {
    B.S.step = i; B.S.mode = 'walk'; resetApproach();
    J.walkT = performance.now();
    J.plan = null;
    J.hops = 0;
  }

  // What actually happened to the last few failed jumps, which is the first
  // thing worth knowing when the bot gets stuck on one step.
  function noteLanding(target, landed) {
    B.S.landings.push('aimed at ' + target + ', ended on ' + landed);
    if (B.S.landings.length > 6) B.S.landings.shift();
  }

  function failStep(landedIdx) {
    var S = B.S;
    S.falls++;
    J.plan = null;
    var key = String(S.target);
    S.fails[key] = (S.fails[key] || 0) + 1;
    if (S.target === 0) { J.mountAvoid = J.mountUsed; J.mountPt = null; }  // that face didn't work
    if (S.fails[key] >= B.cfg.maxAttempts) {
      S.stuckAt = S.target;
      finish(false, 'stuck');
      return;
    }
    if (landedIdx >= 0) enterWalk(landedIdx);
    else { S.mode = 'locate'; S.step = -1; }
  }

  function tick() {
    try {
      tickInner();
    } catch (err) {
      // A throw in here used to leave the bot standing still with no clue why,
      // which is a miserable thing to debug. Record it and stop.
      B.S.error = String(err && err.message || err);
      if (AP.log) AP.log('autoplay error: ' + B.S.error);
      finish(false, 'error');
    }
  }

  function tickInner() {
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
        S.lastProgressAt = performance.now();          // waiting for a round isn't a stall
        if (B.phase === 'waiting' && performance.now() - (B.lastStart || 0) > 1500) {
          B.lastStart = performance.now();
          if (AP.requestStartRound) AP.requestStartRound();
        }
        return;
      }
      // Caught by the lava: ghosts can't win, so there is nothing to do but
      // wait for the round to reset. That's not a stall either.
      if (me.ghost) {
        idle();
        S.mode = 'ghost'; S.step = -1;
        S.lastProgressAt = performance.now();
        return;
      }
      if (S.mode === 'waiting-round' || S.mode === 'ghost') { S.mode = 'locate'; progress('round live'); }
    }

    if (S.mode === 'idle') S.mode = 'locate';

    switch (S.mode) {

      // Work out where we are: on a path platform, on the floor, or still falling.
      case 'locate': {
        idle();
        if (J.locateT === 0) J.locateT = performance.now();
        // Wedged somewhere that is neither a platform nor the floor: treat it
        // as a fall so the retry logic gets a turn, rather than standing here.
        if (performance.now() - J.locateT > 6000) {
          J.locateT = 0;
          failStep(-1);
          return;
        }
        if (!ySteady()) return;
        var i = standingIndex(me);
        if (i >= 0) { J.locateT = 0; enterWalk(i); progress('on platform ' + i); }
        else if (onFloor(me)) {
          S.mode = 'mount'; S.step = -1; resetApproach();
          J.waitT = performance.now();
          J.locateT = 0;
        }
        return;
      }

      // From the floor, hop onto the first platform: walk to a spot a jump's
      // length away from it, face it, jump.
      // From the floor, hop onto the first platform.
      //
      // Take off from where the falling half of the arc crosses the platform's
      // height (the relationship jumpDescentDist() encodes in towers.js) and
      // square up to a face, never a corner: clipping the platform on the way
      // up is resolved by the server as a ceiling hit, which shoves the player
      // down through the ground and out of the world. A diagonal approach clips
      // from any distance under ~3 units, an axis-aligned one is clear from ~1.6.
      //
      // The spot is picked once and walked to in a straight line. Circling the
      // platform to find a face - which is what this used to do - looks daft
      // and walks the player under the platform, where it bumps its head on the
      // underside and stops, since the first platform sits at exactly head
      // height.
      case 'mount': {
        var first = B.path[0];
        if (!J.mountPt) {
          J.mountPt = planMount(me, first);
          if (!J.mountPt) { idle(); return; }         // nothing reachable; wait for a retry
        }
        if (approach(me, J.mountPt, 0.12)) {
          var mAim = faceAngle(me, livePos(first));
          if (!aligned(mAim)) { send(false, false, mAim); return; }
          S.target = 0;
          J.angle = mAim;
          J.tJump = performance.now();
          J.estMs = airTicks(standY(first) - me.y) * TICK_MS;
          J.mountUsed = J.mountPt;
          J.mountPt = null;
          S.jumps++;
          S.mode = 'air';
        }
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
        // Walking is where the bot loses most of its runs: these platforms are
        // barely wider than the player, and every step towards the middle is a
        // chance to step off the edge. So if the jump already works from where
        // we landed, don't move at all.
        var nxtNow = B.path[S.step + 1];
        if (nxtNow && !nxtNow.special && !p.special &&
            evaluateJump(me, faceAngle(me, { x: nxtNow.x, z: nxtNow.z }), B.cfg.lagTicks, S.step + 1)) {
          idle();
          S.mode = 'prejump';
          J.waitT = performance.now();
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
        // Falling off while lining a jump up leaves the step index pointing at
        // a platform we are no longer on; work out where we are instead.
        if (ySteady() && standingIndex(me) !== S.step) { S.mode = 'locate'; J.plan = null; return; }
        if (performance.now() - J.waitT > 20000) { S.target = S.step + 1; failStep(standingIndex(me)); return; }
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
        // platform that distance is what the generator laid the tower out with,
        // so aim at it and go. Anything involving a moving platform has to be
        // timed instead, which planTakeoff works out.
        //
        // Either way the arc is simulated from where the bot is actually
        // standing, and any landing that gets it further up the climb counts —
        // a jump that carries two platforms at once used to be thrown away,
        // and from an awkward spot it is sometimes the only one that works.
        var timed = nxt.special === 'moving' || (cur && cur.special === 'moving');
        var flightTicks = airTicks(standY(nxt) - me.y);
        var jAim;

        if (timed) {
          // Plan once, then stand still and let the ride carry us to the moment
          // we picked. Walking now would invalidate the plan, which assumes we
          // keep whatever spot on the platform we already have.
          if (!J.plan) {
            J.plan = planTakeoff(me, cur, nxt, S.step + 1);
            J.planAt = performance.now();
            if (!J.plan) {
              // Nothing lands from this exact spot. Before giving up, stand
              // somewhere else on the platform and ask again — where you stand
              // changes the whole arc, and an inch off centre can have no
              // window at all when the middle has plenty.
              var cc = cur ? livePos(cur) : null;
              if (cc && !J.triedCentre && Math.hypot(me.x - cc.x, me.z - cc.z) > 0.12) {
                if (approach(me, { x: cc.x, z: cc.z }, 0.12)) { J.triedCentre = true; idle(); }
                return;
              }
              // Pinned somewhere no arc works from? Hop to the middle first.
              if (J.hops < 2 && cur && hopTowards(me, cur)) return;

              // A whole cycle of moments from the middle too: that platform
              // genuinely cannot be reached from here.
              S.target = S.step + 1;
              S.noWindow = S.step + 1;
              J.triedCentre = false;
              failStep(standingIndex(me));
              return;
            }
          }

          var dueAt = J.planAt + J.plan.at * TICK_MS;
          var now = performance.now();
          if (now < dueAt - 4 * TICK_MS || !aligned(J.plan.angle)) {
            send(false, false, J.plan.angle);           // turn, and wait for it
            return;
          }

          // The moment is here, so stop trusting the schedule and check the arc
          // against the state that just arrived: a tick of clock drift or an
          // extra hop of latency is the difference between landing on a moving
          // platform and landing where it used to be. Nudge a tick or a couple
          // of degrees rather than insisting on the instant that was planned.
          var landing = null;
          var laterBy = 0;
          for (var dt = 0; dt <= 3 && !landing && !laterBy; dt++) {
            var hit = bestJump(me, J.plan.angle, FIRE_FAN, B.cfg.lagTicks + dt, S.step + 1);
            if (!hit) continue;
            J.plan.angle = hit.angle;
            if (dt === 0) landing = hit;
            else laterBy = dt;
          }

          if (!landing) {
            // The arc works a tick or two from now rather than this instant, so
            // wait for it — but only ever a few ticks in total. Pushing the
            // moment back every tick moves the deadline away faster than time
            // arrives at it, and the bot waits forever without jumping.
            if (laterBy && J.deferred < 6) {
              J.deferred += laterBy;
              J.plan.at += laterBy;
              S.defers++;
              send(false, false, J.plan.angle);
              return;
            }
            if (now > dueAt + 400) {                    // moment gone; plan a new one
              J.plan = null;
              J.deferred = 0;
              J.triedCentre = false;
              S.replans++;
            }
            send(false, false, J.plan ? J.plan.angle : angOut);
            return;
          }
          J.deferred = 0;

          jAim = J.plan.angle;
          flightTicks = landing.ticks;
          S.target = landing.step;
          J.plan = null;
          J.triedCentre = false;
        } else {
          // Pick the heading first, then turn to it. Checking alignment against
          // the straight-at-the-platform heading and then jumping on a slightly
          // different one means turning back and forth between the two every
          // tick and never taking off at all.
          var base = faceAngle(me, { x: nxt.x, z: nxt.z });
          var ok = bestJump(me, base, AIM_FAN, B.cfg.lagTicks, S.step + 1);

          if (!ok) {
            // Nothing lands from this spot: shuffle towards the middle of the
            // platform and try from there rather than jumping into thin air.
            var c2 = cur ? livePos(cur) : null;
            if (performance.now() - J.waitT < 2500 && c2 &&
                Math.hypot(me.x - c2.x, me.z - c2.z) > 0.12) {
              if (approach(me, { x: c2.x, z: c2.z }, 0.12)) idle();
              return;
            }
            // Can't walk any closer — hop towards the middle and try again.
            if (J.hops < 2 && cur && hopTowards(me, cur)) return;

            // Still nothing: count it as a failed attempt and let the retry
            // come at it fresh. Jumping anyway just throws the bot off the
            // tower and burns the same attempt.
            idle();
            S.target = S.step + 1;
            failStep(S.step);
            return;
          }

          jAim = ok.angle;
          flightTicks = ok.ticks;
          S.target = ok.step;                          // may skip a platform
          if (!aligned(jAim)) { send(false, false, jAim); return; }
        }

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
        // Held a couple of ticks past the simulated landing tick: letting go
        // exactly on it lands short, because the state the estimate was made
        // from is already a tick or two old by the time the arc starts.
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
              noteLanding(S.target, idx);
              failStep(idx);
            }
            return;
          }
          if (onFloor(me)) { idle(); noteLanding(S.target, 'the floor'); failStep(-1); return; }
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

  // Exposed for diagnostics: the local physics and the take-off search.
  AP.simJump = function (pos, ang, oi, t0) { return simulateJump(pos, ang, oi, t0); };
  AP.simJumpTo = function (pos, ang, t0) { return simulateJumpTo(pos, ang, t0); };
  AP.evalJump = function (pos, ang, t0, minStep) { return evaluateJump(pos, ang, t0, minStep); };
  AP.planJump = function (me, cur, nxt, minStep) { return planTakeoff(me, cur, nxt, minStep || 0); };

  AP.dbg = function () { return { ang: curAng, appr: appr, J: J, cfg: B.cfg }; };

  AP.status = function () {
    var S = B.S;
    return {
      mode: S.mode, step: S.step, target: S.target, steps: B.path.length - 1, error: S.error,
      y: S.y, maxY: S.maxY, done: S.done, ok: S.ok, reason: S.reason, note: S.note,
      jumps: S.jumps, falls: S.falls, voids: S.voids, fails: S.fails,
      defers: S.defers, replans: S.replans, hops: S.hops, landings: S.landings,
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
