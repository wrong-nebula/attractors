import { makeOrbit } from "./orbit.js";
const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const media = (item, file) =>
  "./media/" + encodeURIComponent(item.id) + "/" + file;
const serial = (n) => String(n + 1).padStart(3, "0");
const modelName = {
  "2d": "Planar",
  "3d_lifted": "3D lift",
  "3d_hopf": "Hopf lift",
};
const film = $("film"),
  stage = $("stage"),
  canvas = $("orbiter"),
  poster = $("poster");
const indexDialog = $("index-dialog"),
  noteDialog = $("note-dialog");
let items = [],
  current = -1,
  gpu,
  ready = false,
  request,
  plateRequest = 0,
  orbitTimer = 0,
  frame = 0;
let yaw = 0,
  pitch = 0,
  vx = 0,
  vy = 0,
  gesture = null,
  lastFrame = 0;

function plateView() {
  cancelAnimationFrame(frame);
  frame = 0;
  gesture = null;
  vx = vy = yaw = pitch = 0;
  stage.classList.remove("turning", "rotated");
  $("reset").hidden = true;
}
function setReady(value) {
  ready = value;
  stage.classList.toggle("gpu", value);
  $("turn").hidden = !value;
}
async function loadOrbit() {
  request?.abort();
  setReady(false);
  if (!gpu || current < 0) return;
  const item = items[current];
  const controller = new AbortController();
  request = controller;
  try {
    const response = await fetch(media(item, "density.gz"), {
      signal: controller.signal,
    });
    if (!response.ok) throw Error("Missing orbit");
    let data = await response.arrayBuffer();
    // Some static hosts already decode the gzip representation in transit.
    if (new Uint8Array(data)[0] === 0x1f) {
      const stream = new Blob([data])
        .stream()
        .pipeThrough(new DecompressionStream("gzip"));
      data = await new Response(stream).arrayBuffer();
    }
    if (controller !== request || !gpu) return;
    gpu.load(data);
    setReady(true);
  } catch (error) {
    if (error.name !== "AbortError" && controller === request) setReady(false);
  }
}
function draw() {
  if (!ready) return;
  gpu.draw(yaw, pitch);
  stage.classList.add("rotated");
  $("reset").hidden = false;
}
function tick(time) {
  frame = 0;
  if (!ready) return;
  const step = Math.min(2.5, Math.max(0.1, (time - lastFrame) / 16.67));
  lastFrame = time;
  if (!gesture) {
    const damp = Math.pow(0.89, step);
    vx *= damp;
    vy *= damp;
    yaw += vx * step;
    pitch += vy * step;
  }
  draw();
  if (!gesture && Math.abs(vx) + Math.abs(vy) > 0.0008 && !reduced.matches)
    queueFrame();
}
function queueFrame() {
  if (!frame) frame = requestAnimationFrame(tick);
}
stage.addEventListener("pointerdown", (e) => {
  if (!ready || e.button !== 0 || !e.isPrimary) return;
  gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
  vx = vy = 0;
  stage.setPointerCapture(e.pointerId);
  stage.classList.add("turning");
});
stage.addEventListener("pointermove", (e) => {
  if (gesture?.id !== e.pointerId) return;
  const dx = (e.clientX - gesture.x) * 0.009,
    dy = (e.clientY - gesture.y) * 0.009;
  const elapsed = Math.max(8, e.timeStamp - gesture.t);
  yaw += dx;
  pitch -= dy;
  vx = Math.min(0.09, Math.max(-0.09, (dx * 16) / elapsed));
  vy = Math.min(0.09, Math.max(-0.09, (-dy * 16) / elapsed));
  gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
  queueFrame();
});
function endTurn(e) {
  if (gesture?.id !== e.pointerId) return;
  if (
    e.type === "pointercancel" ||
    e.timeStamp - gesture.t > 80 ||
    reduced.matches
  )
    vx = vy = 0;
  gesture = null;
  stage.classList.remove("turning");
  lastFrame = performance.now();
  if (Math.abs(vx) + Math.abs(vy) > 0.0008) queueFrame();
}
stage.addEventListener("pointerup", endTurn);
stage.addEventListener("pointercancel", endTurn);
$("turn").onclick = () => {
  vx = vy = 0;
  yaw += Math.PI / 12;
  draw();
};
$("reset").onclick = () => {
  plateView();
  $("turn").focus();
};
new ResizeObserver(() => {
  if (stage.classList.contains("rotated")) draw();
}).observe(stage);

function tile(item, i) {
  const button = document.createElement("button");
  button.className = "tile";
  button.dataset.index = i;
  button.setAttribute("aria-label", serial(i) + " " + item.title);
  const image = new Image(192, 167);
  image.loading = "lazy";
  image.alt = "";
  image.src = media(item, "thumb.webp");
  image.draggable = false;
  const seq = document.createElement("span");
  seq.className = "ordinal";
  seq.textContent = serial(i);
  button.append(image, seq);
  return button;
}
function select(i, scrubbing = false) {
  if (i === current || !items[i]) return;
  const item = items[i],
    old = current;
  current = i;
  if (old >= 0) {
    film.children[old].removeAttribute("aria-current");
    film.children[old].tabIndex = -1;
  }
  const active = film.children[i];
  active.setAttribute("aria-current", "true");
  active.tabIndex = 0;
  if (film.contains(document.activeElement))
    active.focus({ preventScroll: true });
  {
    const box = active.getBoundingClientRect(),
      rail = film.getBoundingClientRect();
    if (box.left < rail.left || box.right > rail.right)
      film.scrollTo({
        left: film.scrollLeft + box.left - rail.left,
        behavior: reduced.matches || scrubbing ? "instant" : "smooth",
      });
  }
  plateView();
  const ticket = ++plateRequest;
  const url = media(item, "plate.webp"),
    image = new Image();
  image.src = url;
  // Show the correct thumbnail while the full resolution plate decodes, even on a cold link.
  if (old >= 0 || i !== 0) poster.src = media(item, "thumb.webp");
  image
    .decode()
    .then(() => {
      if (ticket === plateRequest) poster.src = url;
    })
    .catch(() => {});
  poster.alt = item.title + ", density portrait of " + item.id;
  stage.setAttribute("aria-label", item.title + " specimen view");
  $("notes").setAttribute("aria-label", "Field notes for " + item.title);
  $("serial").textContent = serial(i);
  $("total").textContent = items.length;
  document.querySelector(".studio").href =
    "./studio/?specimen=" + encodeURIComponent(item.id);
  $("mode").textContent = modelName[item.mode];
  document.documentElement.style.setProperty(
    "--accent",
    "rgb(" + item.rgb.join(",") + ")",
  );
  $("announcement").textContent =
    "Specimen " + (i + 1) + " of " + items.length + ", " + item.title;
  $("scrub").value = String(i);
  $("scrub").setAttribute("aria-valuetext", serial(i) + ", " + item.title);
  clearTimeout(orbitTimer);
  request?.abort();
  setReady(false);
  orbitTimer = setTimeout(loadOrbit, scrubbing ? 120 : 0);
}
function navigate(i) {
  if (!items.length) return;
  i = (i + items.length) % items.length;
  if (current !== i) {
    location.hash = items[i].id;
    select(i);
  }
}
function fromHash() {
  const i = items.findIndex((s) => s.id === location.hash.slice(1));
  select(Math.max(0, i));
}
$("prev").onclick = () => navigate(current - 1);
$("next").onclick = () => navigate(current + 1);
$("scrub").oninput = (e) => select(Number(e.target.value), true);
$("scrub").onchange = () => {
  if (items[current]) location.hash = items[current].id;
};
window.addEventListener("hashchange", fromHash);
document.addEventListener("keydown", (e) => {
  if (
    e.defaultPrevented ||
    e.isComposing ||
    !items.length ||
    e.altKey ||
    e.ctrlKey ||
    e.metaKey ||
    e.shiftKey ||
    document.querySelector("dialog[open]") ||
    e.target.closest?.("input, select, textarea, [contenteditable=true]")
  )
    return;
  switch (e.key) {
    case "ArrowLeft":
      navigate(current - 1);
      break;
    case "ArrowRight":
      navigate(current + 1);
      break;
    case "Home":
      navigate(0);
      break;
    case "End":
      navigate(items.length - 1);
      break;
    case "/":
      openIndex();
      break;
    default:
      return;
  }
  e.preventDefault();
});

// Native touch scrolling on the reel, pointer scrubbing with a mouse.
let scrub = null,
  suppress = false;
film.addEventListener("pointerdown", (e) => {
  suppress = false;
  if (e.pointerType === "mouse" && e.button === 0)
    scrub = { id: e.pointerId, x: e.clientX, start: film.scrollLeft };
});
film.addEventListener("pointermove", (e) => {
  if (
    scrub?.id !== e.pointerId ||
    (!suppress && Math.abs(e.clientX - scrub.x) < 5)
  )
    return;
  suppress = true;
  film.setPointerCapture(e.pointerId);
  film.classList.add("dragging");
  film.scrollLeft = scrub.start + scrub.x - e.clientX;
});
function endScrub() {
  scrub = null;
  film.classList.remove("dragging");
}
window.addEventListener("pointerup", endScrub);
window.addEventListener("pointercancel", endScrub);
film.addEventListener("click", (e) => {
  const hit = e.target.closest(".tile");
  if (hit && (!suppress || e.detail === 0)) navigate(Number(hit.dataset.index));
});

function renderGrid() {
  const needle = $("search").value.trim().toLowerCase(),
    dim = $("filter").value;
  const filtered = items
    .map((s, i) => ({ s, i }))
    .filter(
      ({ s, i }) =>
        (!dim || s.dim === Number(dim)) &&
        [s.id, s.title, serial(i), "cell " + String(s.cell).padStart(3, "0")]
          .join(" ")
          .toLowerCase()
          .includes(needle),
    );
  $("matches").textContent = filtered.length
    ? filtered.length + " specimen" + (filtered.length === 1 ? "" : "s")
    : "No matching specimens";
  $("grid").replaceChildren(...filtered.map(({ s, i }) => tile(s, i)));
}
function openIndex() {
  renderGrid();
  indexDialog.showModal();
  $("search").focus();
}
$("browse").onclick = openIndex;
$("about").onclick = () => $("about-dialog").showModal();
$("search").addEventListener("keydown", (event) => {
  if (
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return;
  const first = $("grid").firstElementChild;
  if (!first) return;
  if (event.key === "ArrowDown") first.focus();
  else if (event.key === "Enter") first.click();
  else return;
  event.preventDefault();
});
$("search").oninput = $("filter").onchange = renderGrid;
$("grid").addEventListener("keydown", (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const grid = event.currentTarget;
  const buttons = Array.from(grid.children);
  const index = buttons.indexOf(event.target);
  if (index === -1) return;
  const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").length;
  let next;
  switch (event.key) {
    case "ArrowLeft":
      next = index - 1;
      break;
    case "ArrowRight":
      next = index + 1;
      break;
    case "ArrowUp":
      next = index - columns;
      break;
    case "ArrowDown":
      next = index + columns;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = buttons.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  if (event.key === "ArrowUp" && next < 0) $("search").focus();
  else buttons[Math.max(0, Math.min(next, buttons.length - 1))].focus();
});
$("grid").onclick = (e) => {
  const hit = e.target.closest(".tile");
  if (hit) {
    indexDialog.close();
    navigate(Number(hit.dataset.index));
  }
};
for (const dialog of [indexDialog, noteDialog, $("about-dialog")]) {
  dialog.querySelector(".close").onclick = () => dialog.close();
  dialog.addEventListener("click", (e) => {
    const box = dialog.getBoundingClientRect();
    if (
      e.target === dialog &&
      (e.clientX < box.left ||
        e.clientX > box.right ||
        e.clientY < box.top ||
        e.clientY > box.bottom)
    )
      dialog.close();
  });
}
$("notes").onclick = () => {
  const s = items[current];
  if (!s) return;
  const rows = [
    ["Grid cell", String(s.cell).padStart(3, "0")],
    ["Model", modelName[s.mode]],
    ["Largest Lyapunov exponent", s.exponent.toFixed(4)],
    ["Formula length", s.size + " bytes"],
  ];
  $("measurements").replaceChildren(
    ...rows.map(([label, value]) => {
      const row = document.createElement("div"),
        dt = document.createElement("dt"),
        dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = value;
      row.append(dt, dd);
      return row;
    }),
  );
  $("formula").textContent = s.formula;
  noteDialog.showModal();
};

async function start() {
  const response = await fetch("./catalog.json");
  if (!response.ok) throw Error("Catalog unavailable");
  const catalog = await response.json();
  items = catalog.species;
  $("evaluated").textContent = catalog.evaluated.toLocaleString("en-US");
  $("scrub").max = items.length - 1;
  film.replaceChildren(
    ...items.map((s, i) => {
      const button = tile(s, i);
      button.tabIndex = -1;
      return button;
    }),
  );
  fromHash();
  try {
    gpu = await makeOrbit(canvas, () => {
      gpu = null;
      request?.abort();
      plateView();
      setReady(false);
    });
    await loadOrbit();
  } catch {
    plateView();
    setReady(false);
  }
}
start().catch(() => {
  $("load-error").textContent = "Collection unavailable.";
  $("load-error").hidden = false;
});
