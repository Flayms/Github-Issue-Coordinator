/*
 * Dashboard script (spec 003). Optional: the page reads fully without it. It adds the countdown and
 * the in-place refresh (REQ-003-06, REQ-003-28), the "Copy name" buttons (REQ-003-01), the comet
 * scrollbar (REQ-003-27) and the animated background with its parallax (REQ-003-14, REQ-003-25).
 * Its only request is a GET of the page's own URL.
 */
(() => {
  // REQ-003-01: copy the Remote Control name. The clipboard needs a secure context (HTTPS or localhost).
  // One listener for the whole page, so buttons a refresh adds work too.
  const canCopy = Boolean(navigator.clipboard && window.isSecureContext);
  const showCopy = () => {
    if (canCopy) for (const button of document.querySelectorAll("button[data-copy]")) button.hidden = false;
  };
  if (canCopy) {
    document.addEventListener("click", (e) => {
      const button = e.target instanceof Element ? e.target.closest("button[data-copy]") : null;
      if (!button) return;
      const text = button.querySelector("span");
      navigator.clipboard.writeText(button.getAttribute("data-copy") || "").then(
        () => {
          button.classList.add("done");
          if (text) text.textContent = "Copied";
          setTimeout(() => {
            button.classList.remove("done");
            if (text) text.textContent = "Copy name";
          }, 1600);
        },
        () => {},
      );
    });
  }
  showCopy();

  // REQ-003-28: the page is patched to the server's newer copy of itself. Matched nodes are kept,
  // so focus, a ticked "Show N more", canvases and running animations survive; only attributes and
  // text that differ are written. Some things belong to this script, not to the server's HTML:
  /** Classes the scripts add; the server never sends them, so a patch must not take them away. */
  const CLIENT_CLASSES = ["gl", "on", "done", "drag"];
  /** The node a new node takes over: the same id, else the next one of the same kind without an id. */
  const sameKind = (a, b) =>
    a.nodeType === b.nodeType && (a.nodeType !== 1 || (a.tagName === b.tagName && a.id === b.id));
  /** Nodes the page's scripts own (the background, the comet): never patched, moved or removed. */
  const owned = (n) => n.nodeType === 1 && (n.id === "bg" || n.classList.contains("comet"));
  const patchAttributes = (cur, next) => {
    for (const { name } of [...cur.attributes]) {
      if (!next.hasAttribute(name) && name !== "class") cur.removeAttribute(name);
    }
    for (const { name, value } of [...next.attributes]) {
      if (name === "class") continue;
      if (cur.getAttribute(name) !== value) cur.setAttribute(name, value);
    }
    const kept = CLIENT_CLASSES.filter((c) => cur.classList.contains(c));
    const cls = [next.getAttribute("class") || "", ...kept.filter((c) => !next.classList.contains(c))].join(" ").trim();
    if ((cur.getAttribute("class") || "") !== cls) {
      if (cls) cur.setAttribute("class", cls);
      else cur.removeAttribute("class");
    }
  };
  const patch = (cur, next) => {
    if (cur.nodeType !== 1) {
      if (cur.nodeValue !== next.nodeValue) cur.nodeValue = next.nodeValue;
      return;
    }
    // A canvas is drawn by a script (a meter's liquid): its size and pixels stay.
    if (cur.tagName === "CANVAS") return;
    patchAttributes(cur, next);
    patchChildren(cur, next);
  };
  const patchChildren = (parent, nextParent) => {
    const pool = [...parent.childNodes].filter((n) => !owned(n));
    const at = 0;
    for (const want of [...nextParent.childNodes]) {
      if (owned(want)) continue;
      let i = at;
      while (i < pool.length && !sameKind(pool[i], want)) i++;
      let node;
      if (i < pool.length) {
        node = pool[i];
        pool.splice(i, 1);
        patch(node, want);
      } else {
        node = document.importNode(want, true);
      }
      // In order after the nodes placed so far.
      const before = pool[at] ?? null;
      if (node.nextSibling !== before || node.parentNode !== parent) parent.insertBefore(node, before);
    }
    for (const n of pool) n.remove();
  };
  /** The stylesheet and scripts a page loads, with their versions. */
  const assets = (doc) =>
    [...doc.querySelectorAll("link[rel=stylesheet], script[src]")]
      .map((e) => e.getAttribute("href") || e.getAttribute("src"))
      .join(" ");

  // REQ-003-06 / REQ-003-28: count down to the next refresh; a hidden tab refreshes once it is shown again.
  const tick = document.querySelector("[data-reload]");
  if (tick) {
    const circumference = 2 * Math.PI * 8;
    const interval = () => Math.max(1, Number(tick.getAttribute("data-reload")) || 60);
    let due = Date.now() + interval() * 1000;
    let busy = false;
    let failed = false;
    const update = () => {
      const total = interval();
      const left = Math.max(0, Math.ceil((due - Date.now()) / 1000));
      const label = tick.querySelector("[data-countdown]");
      const time = left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : `${left} s`;
      if (label) label.textContent = failed ? `failed · ${time}` : time;
      tick.querySelector(".ring-fg")?.setAttribute("stroke-dashoffset", String(circumference * (1 - left / total)));
      if (left === 0 && !document.hidden) refresh();
    };
    const fail = (why) => {
      failed = true;
      tick.setAttribute("data-failed", "");
      tick.setAttribute(
        "title",
        `Refresh failed (${why}); this page shows the state before. It tries again in the next interval.`,
      );
    };
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const res = await fetch(location.href, { credentials: "same-origin", cache: "no-store" });
        // Signed out (an expired token cookie): the whole page, so the Owner sees why.
        if (res.status === 401) return location.reload();
        if (!res.ok) return fail(`HTTP ${res.status}`);
        const next = new DOMParser().parseFromString(await res.text(), "text/html");
        // Another version of the Coordinator, or not a dashboard page: load it the ordinary way.
        if (assets(next) !== assets(document) || !next.querySelector("[data-reload]")) return location.reload();
        if (document.title !== next.title) document.title = next.title;
        patchChildren(document.body, next.body);
        failed = false;
        tick.removeAttribute("data-failed");
        showCopy();
        document.dispatchEvent(new Event("dashboard:refreshed"));
      } catch (e) {
        fail(e instanceof Error ? e.message : "no answer");
      } finally {
        busy = false;
        due = Date.now() + interval() * 1000;
        update();
      }
    };
    update();
    setInterval(update, 1000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && Date.now() >= due) refresh();
    });
  }

  // The scroll as the comet and the background see it: position, and speed in pixels per millisecond.
  const root = document.documentElement;
  const scrollMax = () => Math.max(0, root.scrollHeight - window.innerHeight);
  /** REQ-003-14 / REQ-003-25: for reduced motion nothing follows the scroll. The background still draws. */
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  const METAL = 0.3;
  const GLOW = 0.15;
  let scrollSpeed = 0;
  const scrollListeners = [];
  {
    let lastY = window.scrollY;
    let lastT = performance.now();
    window.addEventListener(
      "scroll",
      () => {
        const now = performance.now();
        const y = window.scrollY;
        const v = (y - lastY) / Math.max(8, now - lastT);
        scrollSpeed += (v - scrollSpeed) * 0.5;
        lastY = y;
        lastT = now;
        for (const f of scrollListeners) f(y);
      },
      { passive: true },
    );
  }

  // REQ-003-25: the glows move at about 15 % of the scroll, also without WebGL.
  let glowFrame = 0;
  const moveGlow = () => {
    glowFrame = 0;
    root.style.setProperty("--glow-y", `${still.matches ? 0 : -Math.round(window.scrollY * GLOW)}px`);
  };
  scrollListeners.push(() => {
    if (!glowFrame) glowFrame = requestAnimationFrame(moveGlow);
  });
  moveGlow();

  // REQ-003-27: the comet replaces the browser's scrollbar. Scrolling stays the browser's; the comet
  // only reads it, plus a drag on its own thumb. It is redrawn at most once a frame and only while
  // something changes; about a second after the scroll stops it slims and dims (CSS, without .on).
  {
    const comet = document.createElement("div");
    comet.className = "comet";
    comet.setAttribute("aria-hidden", "true");
    const thumb = document.createElement("div");
    thumb.className = "comet-thumb";
    const tail = document.createElement("i");
    tail.className = "comet-tail";
    const head = document.createElement("i");
    head.className = "comet-head";
    thumb.append(tail, head);
    comet.append(thumb);
    document.body.append(comet);
    root.classList.add("has-comet");

    let frame = 0;
    let idle = 0;
    let thumbH = 0;
    let trackH = 0;
    const layout = () => {
      const max = scrollMax();
      // Shown first: a hidden comet measures 0 high.
      comet.hidden = max < 1;
      trackH = comet.clientHeight;
      thumbH = Math.max(36, Math.round((trackH * window.innerHeight) / (max + window.innerHeight)));
      thumb.style.height = `${thumbH}px`;
      // The head glides between the thumb's ends by this (CSS translate).
      comet.style.setProperty("--thumb-h", `${thumbH}px`);
    };
    const draw = () => {
      frame = 0;
      const max = scrollMax();
      const y = max ? (Math.min(max, Math.max(0, window.scrollY)) / max) * (trackH - thumbH) : 0;
      thumb.style.transform = `translate3d(0, ${y.toFixed(1)}px, 0)`;
      const speed = Math.abs(scrollSpeed);
      comet.style.setProperty("--stretch", (1 + Math.min(1.2, speed * 0.35)).toFixed(2));
      comet.style.setProperty("--tail", Math.min(1, speed * 0.45).toFixed(2));
      // Without new scroll events the speed decays, so the tail and the stretch settle.
      scrollSpeed *= 0.85;
      if (speed > 0.01) frame = requestAnimationFrame(draw);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    scrollListeners.push(() => {
      if (scrollSpeed > 0.02) comet.dataset.dir = "down";
      else if (scrollSpeed < -0.02) comet.dataset.dir = "up";
      comet.classList.add("on");
      clearTimeout(idle);
      idle = setTimeout(() => comet.classList.remove("on"), 1000);
      schedule();
    });
    const relayout = () => {
      layout();
      schedule();
    };
    window.addEventListener("resize", relayout);
    // The page grows and shrinks without a resize too, e.g. when "Show 10 more" opens.
    if (window.ResizeObserver) new ResizeObserver(relayout).observe(document.body);
    relayout();

    // Drag: the thumb follows the pointer; the page scrolls in proportion.
    thumb.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      thumb.setPointerCapture(e.pointerId);
      comet.classList.add("drag");
      const startY = e.clientY;
      const startScroll = window.scrollY;
      const ratio = scrollMax() / Math.max(1, trackH - thumbH);
      // "instant": the page scrolls smoothly by default (html), which would lag behind the pointer.
      const move = (ev) => window.scrollTo({ top: startScroll + (ev.clientY - startY) * ratio, behavior: "instant" });
      const end = () => {
        comet.classList.remove("drag");
        thumb.removeEventListener("pointermove", move);
        thumb.removeEventListener("pointerup", end);
        thumb.removeEventListener("pointercancel", end);
      };
      thumb.addEventListener("pointermove", move);
      thumb.addEventListener("pointerup", end);
      thumb.addEventListener("pointercancel", end);
    });
  }

  // REQ-003-14: polished dark metal after the v3 mockup in #41 (#87): broad, slow, domain-warped
  // folds that reflect a sharp key light, a highlight strip and a violet fill. The pointer pushes an
  // uneven, lobed dent that smears along its motion. Always on, also for reduced motion (the
  // Owner's call; it moves slowly). Paused in a hidden tab, drawn at reduced scale and about 30
  // frames a second to save battery; without WebGL the static gradient of the page stays.
  const canvas = document.getElementById("bg");
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const gl = canvas.getContext("webgl", { antialias: false, depth: false, powerPreference: "low-power" });
  if (!gl) return;

  /** Smaller is closer in: broader shapes. */
  const ZOOM = 1.9;
  const vertex = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
  const fragment = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 res;
uniform float t;
uniform vec2 m;
uniform vec2 vel;
uniform float energy;
uniform float scroll;
uniform float glow;
const float ZOOM=${ZOOM.toFixed(2)};
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){
  vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);
}
float fbm(vec2 p){
  float v=0.,a=.55;
  mat2 r=mat2(.8,.6,-.6,.8);
  for(int i=0;i<4;i++){v+=a*noise(p);p=r*p*2.;a*=.48;}
  return v;
}
float height(vec2 p){
  vec2 w=p-vec2(0.,scroll);
  vec2 q=vec2(fbm(w+vec2(0.,t*.012)),fbm(w+vec2(5.2,1.3)-t*.009));
  float h=fbm(w*.8+1.4*q);
  vec2 d=p-m;
  d+=.22*(vec2(noise(p*2.3+t*.08),noise(p*2.3+7.1-t*.07))-.5);
  float sp=length(vel);
  vec2 dir=sp>1e-4?vel/sp:vec2(1.,0.);
  float along=dot(d,dir);
  vec2 perp=d-along*dir;
  float stretch=1.+clamp(sp*40.,0.,2.5)*step(along,0.);
  d=perp+dir*along/stretch;
  float ang=atan(d.y,d.x);
  float lobes=1.+.28*sin(ang*3.+t*.25)+.16*sin(ang*5.-t*.18+1.7);
  float r2=dot(d,d)*lobes;
  h-=(.2+.3*energy)*exp(-r2*4.2);
  float r=sqrt(r2);
  h+=.04*energy*sin(r*11.-t*.9+noise(p*3.)*3.)*exp(-r*2.2);
  return h;
}
void main(){
  vec2 uv=gl_FragCoord.xy/res;
  vec2 p=(gl_FragCoord.xy-.5*res)/res.y*ZOOM;
  float e=ZOOM/res.y*1.5;
  float h=height(p),hx=height(p+vec2(e,0.)),hy=height(p+vec2(0.,e));
  vec3 n=normalize(vec3((h-hx)/e,(h-hy)/e,3.4));
  vec3 rf=reflect(vec3(0.,0.,-1.),n);
  float key=pow(max(dot(rf,normalize(vec3(-.45,.55,.7))),0.),14.);
  float strip=smoothstep(.8,1.,1.-abs(rf.x*.8+rf.y*.6-.18))*.3;
  float fill=pow(max(dot(rf,normalize(vec3(.5,-.6,.6))),0.),5.);
  float fres=pow(1.-max(n.z,0.),2.);
  vec3 col=vec3(.035,.038,.06)+vec3(.78,.78,.9)*key*.5+vec3(.9,.9,1.)*strip*.3+vec3(.30,.27,.75)*fill*.5+vec3(.24,.22,.55)*fres*.8;
  col*=.55+.45*smoothstep(1.25,.2,length((uv-vec2(.72,.62+glow))*vec2(1.5,1.)));
  gl_FragColor=vec4(col,1.);
}`;
  const compile = (type, source) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = compile(gl.VERTEX_SHADER, vertex);
  const fs = compile(gl.FRAGMENT_SHADER, fragment);
  if (!vs || !fs) return;
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const at = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(at);
  gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
  const u = (name) => gl.getUniformLocation(program, name);
  const uRes = u("res");
  const uTime = u("t");
  const uMouse = u("m");
  const uVel = u("vel");
  const uEnergy = u("energy");
  const uScroll = u("scroll");
  const uGlow = u("glow");

  const SCALE = 0.75;
  const resize = () => {
    canvas.width = Math.max(1, Math.round(window.innerWidth * SCALE));
    canvas.height = Math.max(1, Math.round(window.innerHeight * SCALE));
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  resize();
  window.addEventListener("resize", resize);

  // The dent follows the pointer with a lag; moving fast deepens it and smears it backwards.
  const toP = (x, y) => [
    ((x - window.innerWidth / 2) / window.innerHeight) * ZOOM,
    (-(y - window.innerHeight / 2) / window.innerHeight) * ZOOM,
  ];
  let target = toP(window.innerWidth * 0.72, window.innerHeight * 0.3);
  const cur = target.slice();
  const vel = [0, 0];
  let energy = 0.2;
  let lastP = null;
  window.addEventListener(
    "pointermove",
    (e) => {
      const p = toP(e.clientX, e.clientY);
      if (lastP) energy = Math.min(1, energy + Math.hypot(p[0] - lastP[0], p[1] - lastP[1]) * 1.4);
      lastP = p;
      target = p;
    },
    { passive: true },
  );

  // REQ-003-25: scrolling stirs the metal like the pointer: its speed adds to the dent's energy.
  scrollListeners.push(() => {
    if (!still.matches) energy = Math.min(1, energy + Math.abs(scrollSpeed) * 0.04);
  });

  const start = performance.now();
  let frame = 0;
  let last = 0;
  const draw = (now) => {
    frame = requestAnimationFrame(draw);
    if (now - last < 33) return;
    // The mockup eased per frame at 60 fps; at about 30 the same easing per frame is taken twice.
    for (let k = 0; k < 2; k++) {
      const nx = cur[0] + (target[0] - cur[0]) * 0.03;
      const ny = cur[1] + (target[1] - cur[1]) * 0.03;
      vel[0] += (nx - cur[0] - vel[0]) * 0.08;
      vel[1] += (ny - cur[1] - vel[1]) * 0.08;
      cur[0] = nx;
      cur[1] = ny;
      energy += (0.2 - energy) * 0.01;
    }
    last = now;
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, (now - start) / 1000);
    gl.uniform2f(uMouse, cur[0], cur[1]);
    gl.uniform2f(uVel, vel[0], vel[1]);
    gl.uniform1f(uEnergy, energy);
    // REQ-003-25: the metal follows the scroll at METAL of its speed, the light at GLOW (in shader
    // units: ZOOM per window height for the metal, a fraction of the height for the light).
    const y = still.matches ? 0 : window.scrollY / window.innerHeight;
    gl.uniform1f(uScroll, y * METAL * ZOOM);
    gl.uniform1f(uGlow, y * GLOW);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    canvas.classList.add("on");
  };
  const run = () => {
    if (!frame && !document.hidden) frame = requestAnimationFrame(draw);
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
  };
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : run()));
  run();
})();
