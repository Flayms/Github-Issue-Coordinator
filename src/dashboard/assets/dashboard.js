/*
 * Dashboard script (spec 003). Optional: the page reads fully without it. It adds the countdown and
 * reload (REQ-003-06), the "Copy name" buttons (REQ-003-01) and the animated background (REQ-003-14).
 * It reads only the page itself and makes no requests.
 */
(() => {
  // REQ-003-06: count down to the next reload; a hidden tab reloads once it is shown again.
  const tick = document.querySelector("[data-reload]");
  if (tick) {
    const total = Math.max(1, Number(tick.getAttribute("data-reload")) || 60);
    const label = tick.querySelector("[data-countdown]");
    const ring = tick.querySelector(".ring-fg");
    const circumference = 2 * Math.PI * 8;
    const due = Date.now() + total * 1000;
    const update = () => {
      const left = Math.max(0, Math.ceil((due - Date.now()) / 1000));
      if (label) {
        label.textContent = left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : `${left} s`;
      }
      ring?.setAttribute("stroke-dashoffset", String(circumference * (1 - left / total)));
      if (left === 0 && !document.hidden) location.reload();
    };
    update();
    setInterval(update, 1000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && Date.now() >= due) location.reload();
    });
  }

  // REQ-003-01: copy the Remote Control name. The clipboard needs a secure context (HTTPS or localhost).
  if (navigator.clipboard && window.isSecureContext) {
    for (const button of document.querySelectorAll("button[data-copy]")) {
      const text = button.querySelector("span");
      button.hidden = false;
      button.addEventListener("click", () => {
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
  vec2 q=vec2(fbm(p+vec2(0.,t*.012)),fbm(p+vec2(5.2,1.3)-t*.009));
  float h=fbm(p*.8+1.4*q);
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
  col*=.55+.45*smoothstep(1.25,.2,length((uv-vec2(.72,.62))*vec2(1.5,1.)));
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
