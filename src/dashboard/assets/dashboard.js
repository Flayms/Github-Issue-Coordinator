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

  // REQ-003-14: a slow dark-metal height field. Always on, also for reduced motion (the Owner's
  // call; it moves slowly). Paused in a hidden tab, drawn at reduced scale and about 30 frames a
  // second to save battery; without WebGL the static gradient of the page stays.
  const canvas = document.getElementById("bg");
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const gl = canvas.getContext("webgl", { antialias: false, depth: false, powerPreference: "low-power" });
  if (!gl) return;

  const vertex = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
  const fragment = `
precision mediump float;
uniform vec2 res;
uniform float time;
uniform vec2 mouse;
uniform float dent;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){
  vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);
}
float fbm(vec2 p){
  float v=0.,a=.5;
  for(int i=0;i<4;i++){v+=a*noise(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}
  return v;
}
float height(vec2 p){
  vec2 q=vec2(fbm(p+time*.018),fbm(p+vec2(5.2,1.3)-time*.013));
  float h=fbm(p*1.15+1.8*q);
  vec2 d=(p-mouse)*vec2(1.,1.25);
  return h-dent*.32*exp(-dot(d,d)*5.);
}
void main(){
  vec2 p=gl_FragCoord.xy/res.y*1.5;
  float e=.006;
  float h=height(p);
  vec3 n=normalize(vec3((h-height(p+vec2(e,0.)))/e*.12,(h-height(p+vec2(0.,e)))/e*.12,1.));
  vec3 l=normalize(vec3(-.45,.6,.65));
  float diff=max(dot(n,l),0.);
  float spec=pow(max(dot(n,normalize(l+vec3(0.,0.,1.))),0.),36.);
  vec3 base=mix(vec3(.018,.02,.04),vec3(.075,.075,.12),h);
  vec3 col=base*(.35+.85*diff)+spec*vec3(.49,.45,1.)*.28;
  vec2 c=gl_FragCoord.xy/res-.5;
  col*=1.-dot(c,c)*1.2;
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
  const uTime = u("time");
  const uMouse = u("mouse");
  const uDent = u("dent");

  const SCALE = 0.75;
  const resize = () => {
    canvas.width = Math.max(1, Math.round(window.innerWidth * SCALE));
    canvas.height = Math.max(1, Math.round(window.innerHeight * SCALE));
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  resize();
  window.addEventListener("resize", resize);

  // The dent follows the pointer with a lag (the smear) and fades when it rests.
  const target = { x: -10, y: -10 };
  const mouse = { x: -10, y: -10 };
  let dent = 0;
  let moved = 0;
  window.addEventListener(
    "pointermove",
    (e) => {
      const h = window.innerHeight;
      target.x = (e.clientX / h) * 1.5;
      target.y = ((h - e.clientY) / h) * 1.5;
      if (mouse.x < -5) {
        mouse.x = target.x;
        mouse.y = target.y;
      }
      moved = performance.now();
    },
    { passive: true },
  );

  const start = performance.now();
  let frame = 0;
  let last = 0;
  const draw = (now) => {
    frame = requestAnimationFrame(draw);
    if (now - last < 33) return;
    last = now;
    mouse.x += (target.x - mouse.x) * 0.06;
    mouse.y += (target.y - mouse.y) * 0.06;
    dent += ((now - moved < 1200 ? 1 : 0) - dent) * 0.04;
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, (now - start) / 1000);
    gl.uniform2f(uMouse, mouse.x, mouse.y);
    gl.uniform1f(uDent, dent);
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
