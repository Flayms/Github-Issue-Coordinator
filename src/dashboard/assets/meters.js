/*
 * Capacity meters (spec 003): the moving liquid of REQ-003-24 and the stirring of REQ-003-26.
 * Optional: without this script or WebGL the CSS liquid stays. With reduced motion it does nothing.
 *
 * One WebGL context, off-screen, draws every meter into its own strip of an atlas, and each strip
 * is copied into that meter's `.brew` canvas (browsers cap WebGL contexts, 2D canvases are cheap).
 * Each meter gets its own seed, so its flow has its own phase, speed and pattern. The liquid has a
 * rounded front that wobbles, broad swirls that never repeat (noise over time), caustics, a band of
 * light and a few bubbles. The pointer stirs it; it calms down in about 2 s. Drawn at about 30
 * frames a second with a capped pixel ratio, and only while the tab is shown and Capacity is in view.
 */
(() => {
  const capacity = document.getElementById("capacity");
  if (!capacity) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (reduced.matches) return;
  const gl = document.createElement("canvas").getContext("webgl", {
    antialias: false,
    depth: false,
    premultipliedAlpha: true,
    powerPreference: "low-power",
  });
  if (!gl) return;

  /** The stir fades to almost nothing (about 2 %) over this many seconds. */
  const STIR_CALM_SEC = 2;
  const MAX_DPR = 2;

  const vertex = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
  const fragment = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 origin;
uniform vec2 size;
uniform float t;
uniform float seed;
uniform float fill;
uniform float stir;
uniform vec2 stirAt;
uniform float slosh;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){
  vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);
}
float fbm(vec2 p){
  float v=0.,a=.55;
  for(int i=0;i<3;i++){v+=a*noise(p);p=mat2(.8,.6,-.6,.8)*p*2.03;a*=.45;}
  return v;
}
void main(){
  // In units of the tube's height: x from the left end, y from the bottom (0..1).
  vec2 q=(gl_FragCoord.xy-origin)/size.y;
  float px=1./size.y;
  float sp=.7+.6*fract(seed*13.7);
  // The rounded front wobbles, and leans when the liquid sloshes.
  float wob=.045*sin(q.y*5.+t*(1.1+.5*fract(seed*7.3))+seed*6.)+.03*sin(-q.y*3.+t*.73*sp+seed*3.);
  float front=fill-.5+wob*(1.+2.5*stir)+slosh*(q.y+.2);
  vec2 c=vec2(clamp(q.x,.5,max(front,.5)),.5);
  float d=length(q-c)-.5;
  float a=smoothstep(px,-px,d);
  if(a<=0.){gl_FragColor=vec4(0.);return;}

  // Stirring swirls the flow around the pointer.
  vec2 dm=q-stirAt;
  float ang=stir*(5.+sin(t*2.7))*exp(-dot(dm,dm)*1.6);
  vec2 p=stirAt+mat2(cos(ang),-sin(ang),sin(ang),cos(ang))*dm;

  // Broad, slow swirls of its own per meter.
  vec2 f=p*vec2(.75,1.2)+seed*37.;
  vec2 w=vec2(fbm(f+vec2(t*.09,0.)*sp),fbm(f+vec2(4.3,1.7)-vec2(0.,t*.07)*sp));
  float n=fbm(f*1.2+1.7*w+vec2(t*.05*sp,0.));
  vec3 hi=vec3(.643,.616,1.),mid=vec3(.486,.447,1.),lo=vec3(.231,.204,.502);
  vec3 col=mix(lo,mid,smoothstep(.0,.55,q.y));
  col=mix(col,hi,smoothstep(.5,1.,q.y));
  col*=.8+.42*n;
  // Caustics where the flow folds.
  float cau=pow(1.-abs(fbm(f*1.15+2.*w-vec2(t*.04,0.))*2.-1.),5.);
  col+=vec3(.82,.82,1.)*cau*(.13+.5*stir);
  // A band of light near the top that drifts, and refracted light near the bottom.
  col+=vec3(1.)*exp(-pow((q.y-.74)/.09,2.))*(.04+.34*smoothstep(.35,.85,noise(vec2(q.x*.55+t*.22*sp+seed*9.,seed*5.))));
  col+=vec3(.9,.9,1.)*exp(-pow((q.y-.15)/.06,2.))*.3*noise(vec2(q.x*1.1-t*.27*sp,seed*3.));

  // A few bubbles rising slowly; stirring brings more, near the pointer.
  for(int i=0;i<5;i++){
    float fi=float(i);
    float h1=hash(vec2(fi+1.,seed*91.)),h2=hash(vec2(seed*57.,fi+3.));
    float life=fract(t*(.06+.07*h2)*(1.+stir)+h1);
    float on=clamp(2.2+3.*stir-fi,0.,1.);
    float bx=mix(.45+h2*max(fill-.9,0.),stirAt.x+(h1-.5)*.8,stir*.7)+.08*sin(t*.8+fi*2.);
    vec2 bp=vec2(bx,.14+life*.72);
    float rr=.075+.04*h1;
    float bd=length(q-bp);
    float disc=smoothstep(rr+px,rr-px,bd);
    float ring=disc*(.3+.7*smoothstep(rr*.35,rr,bd));
    col+=vec3(.9,.9,1.)*ring*on*sin(life*3.1416)*.55;
  }

  // Rounded volume: the edge of the liquid is darker, with a thin lit meniscus.
  col*=1.-.32*smoothstep(-.14,0.,d);
  col+=vec3(.75,.72,1.)*.28*smoothstep(-.07,-.02,d)*smoothstep(.0,-.02,d)*step(.5,q.y);
  gl_FragColor=vec4(col*a,a);
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
  gl.clearColor(0, 0, 0, 0);
  const u = (name) => gl.getUniformLocation(program, name);
  const U = {
    origin: u("origin"),
    size: u("size"),
    t: u("t"),
    seed: u("seed"),
    fill: u("fill"),
    stir: u("stir"),
    stirAt: u("stirAt"),
    slosh: u("slosh"),
  };

  /** A stable number in [0, 1) per meter, from its label and position. */
  const seedOf = (text, i) => {
    let h = 2166136261 + i * 977;
    for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return ((h >>> 0) % 100000) / 100000;
  };

  let meters = [];
  /** Starts drawing the liquid of a meter that has one. */
  const add = (tube, i) => {
    const brew = tube.querySelector("canvas.brew");
    const liquid = tube.querySelector(".liquid");
    const ctx = brew instanceof HTMLCanvasElement ? brew.getContext("2d") : null;
    if (!ctx || !liquid) return;
    const m = {
      tube,
      brew,
      liquid,
      ctx,
      seed: seedOf(tube.closest("li")?.getAttribute("aria-label") || "", i),
      w: 0,
      h: 0,
      fill: 0,
      stir: 0,
      at: [0, 0.5],
      slosh: 0,
      sloshV: 0,
      last: null,
    };
    meters.push(m);
    // REQ-003-26: moving the pointer over the liquid stirs it. Each move adds by the distance it
    // covered (in tube heights), so faster movement stirs more against the calming, whatever the
    // browser's event rate.
    const local = (e) => {
      const r = brew.getBoundingClientRect();
      const h = Math.max(1, r.height);
      return [(e.clientX - r.left) / h, 1 - (e.clientY - r.top) / h];
    };
    tube.addEventListener(
      "pointermove",
      (e) => {
        const p = local(e);
        if (m.last) {
          const dx = p[0] - m.last[0];
          m.stir = Math.min(1, m.stir + Math.min(0.5, Math.hypot(dx, p[1] - m.last[1]) * 0.12));
          m.sloshV += Math.max(-1.2, Math.min(1.2, dx * 0.6));
        }
        m.last = p;
        m.at = p;
      },
      { passive: true },
    );
    tube.addEventListener("pointerleave", () => (m.last = null), { passive: true });
    // A tap on a phone stirs once.
    tube.addEventListener(
      "pointerdown",
      (e) => {
        m.at = local(e);
        m.stir = Math.min(1, m.stir + 0.75);
        m.sloshV += 0.8;
      },
      { passive: true },
    );
  };
  const tubes = () => [...capacity.querySelectorAll(".tube")];
  tubes().forEach(add);

  // The atlas: one strip per meter, stacked.
  let atlasH = 0;
  const layout = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    let width = 1;
    atlasH = 0;
    for (const m of meters) {
      const cw = m.brew.clientWidth;
      const ch = m.brew.clientHeight;
      m.w = Math.max(1, Math.round(cw * dpr));
      m.h = Math.max(1, Math.round(ch * dpr));
      if (m.brew.width !== m.w || m.brew.height !== m.h) {
        m.brew.width = m.w;
        m.brew.height = m.h;
      }
      m.fill = ch > 0 ? m.liquid.offsetWidth / ch : 0;
      m.y = atlasH;
      atlasH += m.h;
      width = Math.max(width, m.w);
    }
    gl.canvas.width = width;
    gl.canvas.height = Math.max(1, atlasH);
  };
  layout();
  window.addEventListener("resize", layout);

  const start = performance.now();
  let frame = 0;
  let last = 0;
  let shown = true;
  const draw = (now) => {
    frame = requestAnimationFrame(draw);
    if (now - last < 33) return;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0.033;
    last = now;
    const t = (now - start) / 1000;
    const calm = Math.exp((-dt * 4) / STIR_CALM_SEC);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    for (const m of meters) {
      // A damped spring: the front sloshes back and forth and settles.
      m.sloshV += (-40 * m.slosh - 5 * m.sloshV) * dt;
      m.slosh = Math.max(-0.3, Math.min(0.3, m.slosh + m.sloshV * dt));
      m.stir *= calm;
      const oy = atlasH - m.y - m.h;
      gl.viewport(0, oy, m.w, m.h);
      gl.uniform2f(U.origin, 0, oy);
      gl.uniform2f(U.size, m.w, m.h);
      gl.uniform1f(U.t, t + m.seed * 400);
      gl.uniform1f(U.seed, m.seed);
      gl.uniform1f(U.fill, m.fill);
      gl.uniform1f(U.stir, m.stir);
      gl.uniform2f(U.stirAt, m.at[0], m.at[1]);
      gl.uniform1f(U.slosh, m.slosh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    // Copied in the same task, before the drawing buffer is cleared.
    for (const m of meters) {
      m.ctx.clearRect(0, 0, m.w, m.h);
      m.ctx.drawImage(gl.canvas, 0, m.y, m.w, m.h, 0, 0, m.w, m.h);
      m.tube.classList.add("gl");
    }
  };
  const run = () => {
    if (!frame && meters.length && shown && !document.hidden && !reduced.matches) frame = requestAnimationFrame(draw);
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
  };
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : run()));
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      shown = entries.some((e) => e.isIntersecting);
      shown ? run() : stop();
    }).observe(capacity);
  }
  // Reduced motion turned on later: back to the still CSS liquid.
  reduced.addEventListener("change", () => {
    if (!reduced.matches) return run();
    stop();
    for (const m of meters) m.tube.classList.remove("gl");
  });
  gl.canvas.addEventListener("webglcontextlost", () => {
    stop();
    for (const m of meters) m.tube.classList.remove("gl");
  });
  // REQ-003-28: a refresh patched the page. A kept meter keeps its flow and is measured again; a
  // meter whose liquid is gone stops, and one that got liquid starts.
  document.addEventListener("dashboard:refreshed", () => {
    meters = meters.filter((m) => {
      const kept = m.tube.isConnected && m.brew.isConnected && m.liquid.isConnected;
      if (!kept) m.tube.classList.remove("gl");
      return kept;
    });
    for (const [i, tube] of tubes().entries()) if (!meters.some((m) => m.tube === tube)) add(tube, i);
    layout();
    meters.length ? run() : stop();
  });
  run();
})();
