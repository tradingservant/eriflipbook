import * as pdfjsLib from '../vendor/pdfjs/pdf.min.js';

const ZOOM_MIN = 1;
const ZOOM_MAX = 3;
const ZOOM_STEPS = [1, 1.25, 1.5, 2, 2.5, 3];
const SPREAD_BREAKPOINT = 960;
const FILE_WARN_BYTES = 120 * 1024 * 1024;

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../vendor/pdfjs/pdf.worker.min.js',
  import.meta.url
).href;

const cMapUrl = new URL('../vendor/pdfjs/cmaps/', import.meta.url).href;
const standardFontDataUrl = new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href;

const els = {
  landing: document.getElementById('landing'),
  landingError: document.getElementById('landing-error'),
  choose: document.getElementById('choose-btn'),
  sample: document.getElementById('sample-btn'),
  reader: document.getElementById('reader'),
  docTitle: document.getElementById('doc-title'),
  stage: document.getElementById('stage'),
  bookMount: document.getElementById('book-mount'),
  hint: document.getElementById('hint'),
  btnFirst: document.getElementById('btn-first'),
  btnPrev: document.getElementById('btn-prev'),
  btnNext: document.getElementById('btn-next'),
  btnLast: document.getElementById('btn-last'),
  indicator: document.getElementById('btn-indicator'),
  btnZoomOut: document.getElementById('btn-zoom-out'),
  btnZoomIn: document.getElementById('btn-zoom-in'),
  zoomLabel: document.getElementById('zoom-label'),
  btnFull: document.getElementById('btn-full'),
  btnOpen: document.getElementById('btn-open'),
  loader: document.getElementById('loader'),
  loaderText: document.getElementById('loader-text'),
  loaderBar: document.getElementById('loader-bar'),
  jumpLayer: document.getElementById('jump-layer'),
  jumpForm: document.getElementById('jump-form'),
  jumpInput: document.getElementById('jump-input'),
  jumpHelp: document.getElementById('jump-help'),
  jumpError: document.getElementById('jump-error'),
  jumpCancel: document.getElementById('jump-cancel'),
  fileInput: document.getElementById('file-input'),
};

const state = {
  token: 0,
  gen: 0,
  pdf: null,
  loadingTask: null,
  flip: null,
  filename: '',
  pageCount: 0,
  pageRatio: 1 / Math.SQRT2,
  frame: null,
  zoom: 1,
  pages: [],
  images: [],
  zooms: [],
  pans: [],
  cache: new Map(),
  tasks: new Set(),
  pumpKey: '',
  pumping: false,
  ready: false,
  helpDismissed: false,
};

let chain = Promise.resolve();
let drag = null;
let pinch = null;

function enqueue(task) {
  chain = chain.then(task).catch((err) => {
    console.error(err);
  });
  return chain;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function coarsePointer() {
  return window.matchMedia('(pointer: coarse)').matches;
}

function wantsSpread() {
  return window.innerWidth >= SPREAD_BREAKPOINT;
}

function setLoader(text, ratio) {
  els.loader.hidden = false;
  els.loaderText.textContent = text;
  if (ratio == null || !Number.isFinite(ratio)) {
    els.loaderBar.classList.add('indeterminate');
    els.loaderBar.style.width = '';
  } else {
    els.loaderBar.classList.remove('indeterminate');
    els.loaderBar.style.width = `${Math.max(4, Math.round(clamp(ratio, 0, 1) * 100))}%`;
  }
}

function hideLoader() {
  els.loader.hidden = true;
}

function showLanding(message) {
  els.reader.hidden = true;
  els.reader.classList.remove('is-fullscreen');
  els.landing.hidden = false;
  els.landingError.textContent = message || '';
  document.title = '翻頁書';
  hideLoader();
}

function showReaderShell() {
  els.landing.hidden = true;
  els.landingError.textContent = '';
  els.reader.hidden = false;
}

function placeholder(pageNumber, status) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="848" viewBox="0 0 600 848">
    <rect width="600" height="848" fill="#fffdf8"/>
    <text x="300" y="410" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#9a8b74">第 ${pageNumber} 頁</text>
    <text x="300" y="452" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#c3b49a">${status}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function cancelTasks() {
  for (const task of state.tasks) {
    try { task.cancel(); } catch (err) { /* already finished */ }
  }
  state.tasks.clear();
}

function isCancelError(err) {
  return !!err && (err.name === 'RenderingCancelledException' || /cancel/i.test(err.message || ''));
}

async function resetBook() {
  state.gen += 1;
  state.ready = false;
  state.pumpKey = '';
  state.pumping = false;
  state.helpDismissed = false;
  state.zoom = 1;
  cancelTasks();
  drag = null;
  pinch = null;
  if (state.loadingTask) {
    const task = state.loadingTask;
    state.loadingTask = null;
    try { await task.destroy(); } catch (err) { /* ignore */ }
  }
  if (state.flip) {
    const flip = state.flip;
    state.flip = null;
    try { flip.destroy(); } catch (err) { console.error(err); }
  }
  if (state.pdf) {
    const pdf = state.pdf;
    state.pdf = null;
    try { await pdf.destroy(); } catch (err) { console.error(err); }
  }
  for (const entry of state.cache.values()) URL.revokeObjectURL(entry.url);
  state.cache.clear();
  state.pages = [];
  state.images = [];
  state.zooms = [];
  state.pans = [];
  state.pageCount = 0;
  state.frame = null;
  els.bookMount.replaceChildren();
  updateZoomLabel();
}

function readFileWithProgress(file, token) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (token !== state.token) return;
      if (event.lengthComputable) setLoader('正在讀取檔案…', event.loaded / event.total);
      else setLoader('正在讀取檔案…', null);
    };
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsArrayBuffer(file);
  });
}

function openFile(file) {
  if (!file) return;
  const name = file.name || '未命名.pdf';
  const looksPdf = file.type === 'application/pdf' || /\.pdf$/i.test(name);
  if (!looksPdf) {
    if (els.reader.hidden) showLanding('請揀一份 PDF 檔。');
    else els.hint.textContent = '請揀一份 PDF 檔。';
    return;
  }
  if (file.size > FILE_WARN_BYTES) {
    const ok = window.confirm('呢份檔案超過 120 MB，手機可能會唔夠記憶體。仍然要開啟？');
    if (!ok) return;
  }
  enqueue(() => loadFromFile(file, name));
}

async function loadFromFile(file, name) {
  const token = ++state.token;
  showReaderShell();
  setLoader('正在讀取檔案…', null);
  let data;
  try {
    data = await readFileWithProgress(file, token);
  } catch (err) {
    if (token !== state.token) return;
    console.error(err);
    showLanding('讀取檔案失敗，請再試一次。');
    return;
  }
  if (token !== state.token) return;
  await openData(data, name, token);
}

function openSample() {
  enqueue(async () => {
    const token = ++state.token;
    showReaderShell();
    setLoader('正在準備範例…', null);
    await openData(buildSamplePdf(), '範例.pdf', token);
  });
}

async function openData(data, filename, token) {
  await resetBook();
  if (token !== state.token) return;
  showReaderShell();
  setLoader('正在開啟 PDF…', null);
  state.filename = filename;

  const task = pdfjsLib.getDocument({
    data,
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    disableRange: true,
    disableStream: true,
    isEvalSupported: false,
    verbosity: 0,
  });
  state.loadingTask = task;
  task.onProgress = (progress) => {
    if (token !== state.token) return;
    if (progress && progress.total) setLoader('正在開啟 PDF…', progress.loaded / progress.total);
  };

  let pdf;
  try {
    pdf = await task.promise;
  } catch (err) {
    if (token !== state.token) return;
    console.error(err);
    const password = err && (err.name === 'PasswordException' || err.code === 1 || err.code === 2);
    showLanding(password ? '呢份 PDF 有密碼保護，暫時未支援。' : '打唔開呢份 PDF。可能係檔案壞咗，或者唔係 PDF。');
    return;
  }
  if (token !== state.token) {
    try { await pdf.destroy(); } catch (err) { /* ignore */ }
    return;
  }
  state.loadingTask = null;
  state.pdf = pdf;
  state.pageCount = pdf.numPages;
  if (!state.pageCount) {
    showLanding('呢份 PDF 冇任何頁面。');
    return;
  }

  try {
    const first = await pdf.getPage(1);
    const view = first.getViewport({ scale: 1 });
    state.pageRatio = view.width / view.height || state.pageRatio;
    first.cleanup();
  } catch (err) {
    if (token !== state.token) return;
    console.error(err);
    showLanding('打唔開呢份 PDF。可能係檔案壞咗，或者唔係 PDF。');
    return;
  }
  if (token !== state.token) return;

  setLoader(`正在準備頁面…（共 ${state.pageCount} 頁）`, null);
  const built = await buildPages(state.pageCount, token);
  if (!built || token !== state.token) return;

  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
  if (token !== state.token) return;
  const frame = measureFrame();
  state.frame = frame;

  const book = document.createElement('div');
  book.className = 'book';
  book.style.width = `${frame.width}px`;
  book.style.height = `${frame.height}px`;
  els.bookMount.appendChild(book);

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let flip;
  try {
    flip = new window.St.PageFlip(book, {
      width: 600,
      height: Math.max(1, Math.round(600 / state.pageRatio)),
      size: 'stretch',
      minWidth: 100,
      maxWidth: 10000,
      minHeight: 100,
      maxHeight: 10000,
      drawShadow: true,
      flippingTime: reduceMotion ? 280 : 800,
      usePortrait: true,
      startZIndex: 8,
      autoSize: false,
      maxShadowOpacity: 0.5,
      showCover: true,
      mobileScrollSupport: true,
      swipeDistance: 30,
      clickEventForward: true,
      useMouseEvents: true,
      showPageCorners: true,
      disableFlipByClick: false,
      startPage: 0,
    });
  } catch (err) {
    console.error(err);
    showLanding('翻頁元件載入失敗。請重新整理頁面。');
    return;
  }

  flip.getSettings().forcePortrait = !frame.spread;
  state.flip = flip;
  flip.loadFromHTML(built.pages);
  applyFrame(frame);

  flip.on('flip', () => {
    updateChrome();
    if (state.ready) schedulePump();
  });
  flip.on('changeState', (event) => {
    if (event.data === 'read') updateChrome();
  });

  updateChrome();
  const gen = state.gen;
  const bucket = currentBucket();
  const visible = visibleIndexes();
  for (let i = 0; i < visible.length; i += 1) {
    if (token !== state.token || gen !== state.gen) return;
    setLoader(`正在繪製第 ${i + 1} / ${visible.length} 頁…`, (i) / visible.length);
    try {
      await paintPage(visible[i], bucket, gen);
    } catch (err) {
      if (token !== state.token || gen !== state.gen || isCancelError(err)) return;
      console.error(err);
    }
  }
  if (token !== state.token || gen !== state.gen) return;

  state.ready = true;
  els.docTitle.textContent = filename;
  document.title = `${filename} — 翻頁書`;
  updateChrome();
  updateHint();
  hideLoader();
  schedulePump();
}

async function buildPages(count, token) {
  const pages = [];
  const images = [];
  const zooms = [];
  const pans = [];
  for (let i = 0; i < count; i += 1) {
    if (token !== state.token) return null;
    const page = document.createElement('div');
    page.className = 'page';
    page.dataset.page = String(i + 1);
    const zoom = document.createElement('div');
    zoom.className = 'page-zoom';
    const img = document.createElement('img');
    img.alt = `第 ${i + 1} 頁`;
    img.draggable = false;
    img.src = placeholder(i + 1, '載入中');
    zoom.appendChild(img);
    page.appendChild(zoom);
    pages.push(page);
    images.push(img);
    zooms.push(zoom);
    pans.push({ x: 0, y: 0 });
    if (i > 0 && i % 40 === 0) {
      setLoader(`正在準備頁面…（${i} / ${count}）`, i / count);
      await delay(0);
    }
  }
  state.pages = pages;
  state.images = images;
  state.zooms = zooms;
  state.pans = pans;
  return { pages };
}

function measureFrame() {
  const cs = getComputedStyle(els.stage);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const availW = Math.max(180, els.stage.clientWidth - padX);
  const availH = Math.max(180, els.stage.clientHeight - padY);
  const spread = wantsSpread();
  const ratio = state.pageRatio;
  if (spread) {
    let width = availW;
    let height = width / (2 * ratio);
    if (height > availH) {
      height = availH;
      width = height * 2 * ratio;
    }
    return { width: Math.round(width), height: Math.round(height), spread: true };
  }
  let width = availW;
  let height = width / ratio;
  if (height > availH) {
    height = availH;
    width = height * ratio;
  }
  return { width: Math.round(width), height: Math.round(height), spread: false };
}

function applyFrame(frame) {
  const book = els.bookMount.querySelector('.book');
  if (!book || !state.flip) return;
  state.frame = frame;
  book.style.width = `${frame.width}px`;
  book.style.height = `${frame.height}px`;
  const wrapper = book.querySelector('.stf__wrapper');
  const block = book.querySelector('.stf__block');
  if (wrapper) {
    wrapper.style.setProperty('width', `${frame.width}px`, 'important');
    wrapper.style.setProperty('height', `${frame.height}px`, 'important');
    wrapper.style.setProperty('padding-bottom', '0px', 'important');
  }
  if (block) {
    block.style.setProperty('width', `${frame.width}px`, 'important');
    block.style.setProperty('height', `${frame.height}px`, 'important');
  }
  const settings = state.flip.getSettings();
  settings.forcePortrait = !frame.spread;
  settings.disableFlipByClick = state.zoom > 1.001;
  book.style.touchAction = state.zoom > 1.001 ? 'none' : '';
  state.flip.update();
}

function layout() {
  if (!state.flip) return;
  applyFrame(measureFrame());
  applyZoomStyles();
  updateChrome();
}

function pageBox() {
  const frame = state.frame || { width: 300, height: 400, spread: false };
  return {
    width: frame.spread ? frame.width / 2 : frame.width,
    height: frame.height,
  };
}

function visibleIndexes() {
  if (!state.flip || !state.pageCount) return [0];
  const start = state.flip.getCurrentPageIndex();
  const end = spreadEnd(start);
  const list = [];
  for (let i = start; i <= end; i += 1) list.push(i);
  return list;
}

function spreadEnd(index) {
  if (!state.flip || state.flip.getOrientation() !== 'landscape') return index;
  if (index <= 0 || index >= state.pageCount - 1) return index;
  if (index % 2 === 1 && index + 1 < state.pageCount) return index + 1;
  return index;
}

function wantedPages() {
  const visible = visibleIndexes();
  const first = visible[0];
  const last = visible[visible.length - 1];
  const indexes = [];
  for (let i = first - 2; i <= last + 4; i += 1) {
    if (i >= 0 && i < state.pageCount) indexes.push(i);
  }
  const visibleSet = new Set(visible);
  indexes.sort((a, b) => {
    const da = visibleSet.has(a) ? -1 : Math.min(Math.abs(a - first), Math.abs(a - last));
    const db = visibleSet.has(b) ? -1 : Math.min(Math.abs(b - first), Math.abs(b - last));
    return da - db || a - b;
  });
  return indexes;
}

function currentBucket() {
  const box = pageBox();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const raw = box.width * Math.max(1, state.zoom) * dpr;
  const cap = window.innerWidth < SPREAD_BREAKPOINT ? 1600 : 2000;
  const px = Math.max(480, Math.min(cap, Math.round(raw || 480)));
  return Math.round(px / 64) * 64;
}

let pumpTimer = 0;
function schedulePump() {
  clearTimeout(pumpTimer);
  pumpTimer = setTimeout(() => { void runPump(); }, 40);
}

async function runPump() {
  if (!state.pdf || !state.flip || !state.ready) return;
  const bucket = currentBucket();
  const wanted = wantedPages();
  const key = `${bucket}|${wanted.join(',')}`;
  if (key === state.pumpKey) return;
  state.pumpKey = key;
  const gen = ++state.gen;
  cancelTasks();
  evictExcept(new Set(wanted));
  const pending = wanted.filter((index) => {
    const hit = state.cache.get(index);
    return !hit || hit.bucket < bucket * 0.92;
  });
  if (!pending.length) {
    setPumping(false);
    return;
  }
  setPumping(true);
  for (const index of pending) {
    if (gen !== state.gen) return;
    try {
      await paintPage(index, bucket, gen);
    } catch (err) {
      if (gen !== state.gen || isCancelError(err)) return;
      console.error(err);
      if (state.images[index]) state.images[index].src = placeholder(index + 1, '顯示唔到');
    }
    await delay(16);
  }
  if (gen === state.gen) setPumping(false);
}

function evictExcept(keep) {
  for (const [index, entry] of state.cache) {
    if (keep.has(index)) continue;
    URL.revokeObjectURL(entry.url);
    state.cache.delete(index);
    const img = state.images[index];
    if (img) img.src = placeholder(index + 1, '載入中');
  }
}

async function paintPage(index, pixelWidth, gen) {
  const cached = state.cache.get(index);
  if (cached && cached.bucket >= pixelWidth * 0.92) return;
  const blob = await rasterize(index + 1, pixelWidth, gen);
  if (!blob || gen !== state.gen) return;
  const url = URL.createObjectURL(blob);
  if (gen !== state.gen) {
    URL.revokeObjectURL(url);
    return;
  }
  const previous = state.cache.get(index);
  state.cache.set(index, { url, bucket: pixelWidth });
  const img = state.images[index];
  if (img) await decodeImage(img, url);
  if (previous && previous.url !== url) URL.revokeObjectURL(previous.url);
}

function decodeImage(img, url) {
  return new Promise((resolve) => {
    const finish = () => resolve();
    img.onload = finish;
    img.onerror = finish;
    img.src = url;
    if (img.complete && img.naturalWidth > 0 && img.src === url) finish();
  });
}

async function rasterize(pageNumber, pixelWidth, gen) {
  const pdfPage = await state.pdf.getPage(pageNumber);
  if (gen !== state.gen) {
    pdfPage.cleanup();
    return null;
  }
  const base = pdfPage.getViewport({ scale: 1 });
  let cssW = Math.max(1, pixelWidth);
  let cssH = Math.max(1, Math.round(cssW / state.pageRatio));
  const edge = Math.max(cssW, cssH);
  if (edge > 4096) {
    const scaleDown = 4096 / edge;
    cssW = Math.max(1, Math.round(cssW * scaleDown));
    cssH = Math.max(1, Math.round(cssH * scaleDown));
  }
  const canvas = document.createElement('canvas');
  canvas.width = cssW;
  canvas.height = cssH;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fffdf8';
  ctx.fillRect(0, 0, cssW, cssH);

  const contain = Math.min(cssW / base.width, cssH / base.height);
  const viewport = pdfPage.getViewport({ scale: contain });
  const temp = document.createElement('canvas');
  temp.width = Math.max(1, Math.ceil(viewport.width));
  temp.height = Math.max(1, Math.ceil(viewport.height));
  const tempCtx = temp.getContext('2d', { alpha: false });
  const renderTask = pdfPage.render({ canvasContext: tempCtx, viewport });
  state.tasks.add(renderTask);
  try {
    await renderTask.promise;
  } catch (err) {
    state.tasks.delete(renderTask);
    pdfPage.cleanup();
    canvas.width = 0;
    canvas.height = 0;
    temp.width = 0;
    temp.height = 0;
    if (isCancelError(err) || gen !== state.gen) return null;
    throw err;
  }
  state.tasks.delete(renderTask);
  if (gen !== state.gen) {
    pdfPage.cleanup();
    canvas.width = 0;
    canvas.height = 0;
    temp.width = 0;
    temp.height = 0;
    return null;
  }
  const ox = (cssW - temp.width) / 2;
  const oy = (cssH - temp.height) / 2;
  ctx.drawImage(temp, ox, oy);
  temp.width = 0;
  temp.height = 0;
  pdfPage.cleanup();
  const blob = await new Promise((resolve) => {
    if (canvas.toBlob.length) canvas.toBlob((result) => resolve(result), 'image/webp', 0.9);
    else resolve(null);
  });
  const finalBlob = blob || await new Promise((resolve) => {
    canvas.toBlob((result) => resolve(result), 'image/jpeg', 0.86);
  });
  canvas.width = 0;
  canvas.height = 0;
  return finalBlob;
}

function setPumping(on) {
  state.pumping = on;
  updateHint();
}

function updateHint() {
  if (!state.flip || els.reader.hidden) {
    els.hint.textContent = '';
    return;
  }
  if (state.pumping) {
    els.hint.textContent = '正在載入附近頁面…';
    return;
  }
  if (!state.helpDismissed) {
    els.hint.textContent = coarsePointer()
      ? '左右滑動，或者撳頁面邊緣翻頁。'
      : '撳頁面邊緣，或者用左右方向鍵翻頁。';
    return;
  }
  els.hint.textContent = '';
}

function updateChrome() {
  if (!state.flip || !state.pageCount) return;
  const index = state.flip.getCurrentPageIndex();
  const end = spreadEnd(index);
  const label = end === index
    ? `${index + 1} / ${state.pageCount}`
    : `${index + 1}–${end + 1} / ${state.pageCount}`;
  els.indicator.textContent = label;
  els.indicator.setAttribute(
    'aria-label',
    end === index
      ? `跳去第幾頁，而家係第 ${index + 1} 頁，共 ${state.pageCount} 頁`
      : `跳去第幾頁，而家係第 ${index + 1} 至 ${end + 1} 頁，共 ${state.pageCount} 頁`
  );
  els.btnFirst.disabled = index <= 0;
  els.btnPrev.disabled = index <= 0;
  els.btnNext.disabled = end >= state.pageCount - 1;
  els.btnLast.disabled = end >= state.pageCount - 1;
  updateZoomLabel();
  updateFullLabel();
}

function updateZoomLabel() {
  els.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
  els.btnZoomOut.disabled = state.zoom <= ZOOM_MIN + 0.001;
  els.btnZoomIn.disabled = state.zoom >= ZOOM_MAX - 0.001;
}

function applyZoomStyles() {
  const z = String(state.zoom);
  for (let i = 0; i < state.zooms.length; i += 1) {
    state.zooms[i].style.setProperty('--z', z);
    state.zooms[i].style.setProperty('--x', `${state.pans[i].x}px`);
    state.zooms[i].style.setProperty('--y', `${state.pans[i].y}px`);
  }
  const book = els.bookMount.querySelector('.book');
  if (book) book.classList.toggle('is-zoomed', state.zoom > 1.001);
}

function setZoom(next) {
  if (!state.flip) return;
  const prev = state.zoom;
  next = clamp(next, ZOOM_MIN, ZOOM_MAX);
  if (Math.abs(next - prev) < 0.001) return;
  const box = pageBox();
  if (next === 1) {
    for (const pan of state.pans) {
      pan.x = 0;
      pan.y = 0;
    }
  } else {
    const scale = next / prev;
    const cx = box.width / 2;
    const cy = box.height / 2;
    for (const pan of state.pans) {
      pan.x = cx - (cx - pan.x) * scale;
      pan.y = cy - (cy - pan.y) * scale;
      clampPan(pan, next, box.width, box.height);
    }
  }
  state.zoom = next;
  const book = els.bookMount.querySelector('.book');
  if (book && state.flip) {
    state.flip.getSettings().disableFlipByClick = next > 1.001;
    book.style.touchAction = next > 1.001 ? 'none' : '';
  }
  applyZoomStyles();
  updateZoomLabel();
  schedulePump();
}

function clampPan(pan, zoom, pageW, pageH) {
  const minX = Math.min(0, pageW - pageW * zoom);
  const minY = Math.min(0, pageH - pageH * zoom);
  pan.x = clamp(pan.x, minX, 0);
  pan.y = clamp(pan.y, minY, 0);
}

function zoomByStep(direction) {
  if (direction > 0) {
    const next = ZOOM_STEPS.find((step) => step > state.zoom + 0.01);
    setZoom(next || ZOOM_MAX);
  } else {
    const prev = [...ZOOM_STEPS].reverse().find((step) => step < state.zoom - 0.01);
    setZoom(prev || ZOOM_MIN);
  }
}

function flippingNow() {
  return !!(state.flip && state.flip.getState() === 'flipping');
}

function goNext() {
  if (!state.ready || !state.flip || flippingNow()) return;
  if (els.btnNext.disabled) return;
  state.helpDismissed = true;
  state.flip.flipNext();
}

function goPrev() {
  if (!state.ready || !state.flip || flippingNow()) return;
  if (els.btnPrev.disabled) return;
  state.helpDismissed = true;
  state.flip.flipPrev();
}

function goFirst() {
  if (!state.ready || !state.flip || flippingNow()) return;
  state.helpDismissed = true;
  state.flip.turnToPage(0);
}

function goLast() {
  if (!state.ready || !state.flip || flippingNow()) return;
  state.helpDismissed = true;
  state.flip.turnToPage(state.pageCount - 1);
}

function goToIndex(index) {
  if (!state.ready || !state.flip || flippingNow()) return;
  index = clamp(index, 0, state.pageCount - 1);
  const current = state.flip.getCurrentPageIndex();
  if (index === current) return;
  state.helpDismissed = true;
  const portrait = state.flip.getOrientation() !== 'landscape';
  const step = portrait ? 1 : 2;
  if (index > current && index <= current + step) state.flip.flipNext();
  else if (index < current && index >= current - step) state.flip.flipPrev();
  else state.flip.turnToPage(index);
}

function openJump() {
  if (!state.pageCount) return;
  const current = state.flip.getCurrentPageIndex() + 1;
  els.jumpInput.min = '1';
  els.jumpInput.max = String(state.pageCount);
  els.jumpInput.value = String(current);
  els.jumpHelp.textContent = `共 ${state.pageCount} 頁`;
  els.jumpError.textContent = '';
  els.jumpLayer.hidden = false;
  els.jumpInput.focus();
  els.jumpInput.select();
}

function closeJump() {
  els.jumpLayer.hidden = true;
  els.indicator.focus();
}

function fullscreenActive() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || els.reader.classList.contains('is-fullscreen'));
}

function updateFullLabel() {
  const on = fullscreenActive();
  els.btnFull.textContent = on ? '退出全螢幕' : '全螢幕';
  els.btnFull.setAttribute('aria-label', on ? '退出全螢幕' : '全螢幕');
}

async function toggleFullscreen() {
  const active = fullscreenActive();
  if (active) {
    els.reader.classList.remove('is-fullscreen');
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit && (document.fullscreenElement || document.webkitFullscreenElement)) {
      try { await exit.call(document); } catch (err) { /* ignore */ }
    }
  } else {
    const req = els.reader.requestFullscreen || els.reader.webkitRequestFullscreen;
    if (req) {
      try {
        await req.call(els.reader);
      } catch (err) {
        els.reader.classList.add('is-fullscreen');
      }
    } else {
      els.reader.classList.add('is-fullscreen');
    }
  }
  updateFullLabel();
  setTimeout(layout, 60);
}

function pageIndexFromEvent(event) {
  const page = event.target && event.target.closest ? event.target.closest('.page') : null;
  if (!page) return state.flip ? state.flip.getCurrentPageIndex() : 0;
  return Number(page.dataset.page) - 1;
}

function panBy(index, dx, dy) {
  if (!state.pans[index]) return;
  const box = pageBox();
  const pan = state.pans[index];
  pan.x += dx;
  pan.y += dy;
  clampPan(pan, state.zoom, box.width, box.height);
  state.zooms[index].style.setProperty('--x', `${pan.x}px`);
  state.zooms[index].style.setProperty('--y', `${pan.y}px`);
}

function pointOf(event) {
  if (event.touches && event.touches[0]) return event.touches[0];
  if (event.changedTouches && event.changedTouches[0]) return event.changedTouches[0];
  return event;
}

function onTouchStart(event) {
  if (!state.ready || !state.flip) return;
  if (event.touches.length >= 2) {
    const [a, b] = event.touches;
    pinch = {
      dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      zoom: state.zoom,
    };
    drag = null;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (state.zoom <= 1.001) return;
  const touch = event.touches[0];
  drag = {
    x: touch.clientX,
    y: touch.clientY,
    moved: false,
    index: pageIndexFromEvent(event),
    pointer: 'touch',
  };
  event.preventDefault();
  event.stopPropagation();
  els.bookMount.querySelector('.book')?.classList.add('is-panning');
}

function onTouchMove(event) {
  if (pinch && event.touches.length >= 2) {
    const [a, b] = event.touches;
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (pinch.dist > 0) setZoom(pinch.zoom * (dist / pinch.dist));
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (!drag || drag.pointer !== 'touch') return;
  const touch = event.touches[0];
  const dx = touch.clientX - drag.x;
  const dy = touch.clientY - drag.y;
  if (Math.hypot(dx, dy) > 4) drag.moved = true;
  drag.x = touch.clientX;
  drag.y = touch.clientY;
  panBy(drag.index, dx, dy);
  event.preventDefault();
  event.stopPropagation();
}

function onTouchEnd(event) {
  if (pinch && event.touches.length < 2) {
    pinch = null;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (!drag || drag.pointer !== 'touch') return;
  const touch = event.changedTouches[0];
  finishDrag(touch.clientX, touch.clientY, drag);
  event.preventDefault();
  event.stopPropagation();
}

function onMouseDown(event) {
  if (!state.ready || state.zoom <= 1.001 || event.button !== 0) return;
  drag = {
    x: event.clientX,
    y: event.clientY,
    moved: false,
    index: pageIndexFromEvent(event),
    pointer: 'mouse',
  };
  event.preventDefault();
  event.stopPropagation();
  els.bookMount.querySelector('.book')?.classList.add('is-panning');
}

function onMouseMove(event) {
  if (state.zoom <= 1.001) return;
  const inBook = !!(event.target && event.target.closest && els.bookMount.contains(event.target));
  if (!drag || drag.pointer !== 'mouse') {
    if (inBook) event.stopPropagation();
    return;
  }
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (Math.hypot(dx, dy) > 4) drag.moved = true;
  drag.x = event.clientX;
  drag.y = event.clientY;
  panBy(drag.index, dx, dy);
  event.preventDefault();
  event.stopPropagation();
}

function onMouseUp(event) {
  if (!drag || drag.pointer !== 'mouse') return;
  finishDrag(event.clientX, event.clientY, drag);
  event.preventDefault();
  event.stopPropagation();
}

function finishDrag(clientX, clientY, session) {
  drag = null;
  els.bookMount.querySelector('.book')?.classList.remove('is-panning');
  if (session.moved) return;
  const book = els.bookMount.querySelector('.book');
  if (!book) return;
  const rect = book.getBoundingClientRect();
  const x = clientX - rect.left;
  if (x < rect.width * 0.18) goPrev();
  else if (x > rect.width * 0.82) goNext();
}

function hasFiles(event) {
  const types = event.dataTransfer && event.dataTransfer.types;
  if (!types) return false;
  return Array.from(types).includes('Files');
}

function buildSamplePdf() {
  const encoder = new TextEncoder();
  const pageCount = 8;
  const colors = [
    '0.49 0.18 0.15',
    '0.16 0.33 0.38',
    '0.36 0.28 0.14',
    '0.22 0.36 0.28',
    '0.40 0.20 0.28',
    '0.18 0.26 0.42',
    '0.45 0.32 0.16',
    '0.30 0.22 0.18',
  ];
  const bodies = new Map();
  const kids = [];
  for (let i = 0; i < pageCount; i += 1) {
    const pageObj = 4 + i * 2;
    const contentObj = pageObj + 1;
    kids.push(`${pageObj} 0 R`);
    const n = i + 1;
    const stream = [
      '0.97 0.95 0.91 rg',
      '0 0 595 842 re f',
      `${colors[i]} rg`,
      '0 752 595 90 re f',
      '0.84 0.78 0.68 rg',
      '48 250 180 220 re f',
      'BT',
      '/F1 20 Tf',
      '1 0.96 0.92 rg',
      '40 784 Td',
      '(Eri Flipbook) Tj',
      '0 0 0 rg',
      '/F1 68 Tf',
      '0 -250 Td',
      `(${n}) Tj`,
      '/F1 18 Tf',
      '0 -46 Td',
      `(Page ${n} of ${pageCount}) Tj`,
      '0 -28 Td',
      '(Generated in the browser. Not uploaded.) Tj',
      'ET',
    ].join('\n');
    bodies.set(contentObj, `<< /Length ${encoder.encode(stream).length} >>\nstream\n${stream}\nendstream`);
    bodies.set(pageObj, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentObj} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
  }
  bodies.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  bodies.set(2, `<< /Type /Pages /Count ${pageCount} /Kids [${kids.join(' ')}] >>`);
  bodies.set(1, '<< /Type /Catalog /Pages 2 0 R >>');

  const maxObj = 3 + pageCount * 2;
  const parts = [];
  let length = 0;
  const offsets = [0];
  const write = (text) => {
    const bytes = encoder.encode(text);
    parts.push(bytes);
    length += bytes.length;
  };
  write('%PDF-1.4\n');
  for (let i = 1; i <= maxObj; i += 1) {
    offsets[i] = length;
    write(`${i} 0 obj\n${bodies.get(i)}\nendobj\n`);
  }
  const xrefAt = length;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxObj; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  write(xref);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function onKeyDown(event) {
  if (event.key === 'Escape' && !els.jumpLayer.hidden) {
    event.preventDefault();
    closeJump();
    return;
  }
  if (event.key === 'Escape' && els.reader.classList.contains('is-fullscreen') && !document.fullscreenElement) {
    els.reader.classList.remove('is-fullscreen');
    updateFullLabel();
    layout();
    return;
  }
  if (!els.jumpLayer.hidden) return;
  if (event.target && event.target.closest && event.target.closest('input, textarea')) return;
  if (!state.ready) return;
  if (event.key === 'ArrowRight' || event.key === 'PageDown') {
    event.preventDefault();
    goNext();
  } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
    event.preventDefault();
    goPrev();
  } else if (event.key === 'Home') {
    event.preventDefault();
    goFirst();
  } else if (event.key === 'End') {
    event.preventDefault();
    goLast();
  } else if (event.key === '+' || event.key === '=') {
    event.preventDefault();
    zoomByStep(1);
  } else if (event.key === '-' || event.key === '_') {
    event.preventDefault();
    zoomByStep(-1);
  } else if (event.key === 'f' || event.key === 'F') {
    event.preventDefault();
    toggleFullscreen();
  }
}

function bind() {
  if (!window.St || !window.St.PageFlip) {
    showLanding('翻頁元件載入失敗。請重新整理頁面。');
  }
  if (location.protocol === 'file:') {
    els.landingError.textContent = '請用網頁伺服器開啟呢個網站（例如 GitHub Pages），唔好直接開檔案。';
  }

  els.choose.addEventListener('click', () => els.fileInput.click());
  els.btnOpen.addEventListener('click', () => els.fileInput.click());
  els.sample.addEventListener('click', openSample);
  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files && els.fileInput.files[0];
    els.fileInput.value = '';
    if (file) openFile(file);
  });

  els.btnFirst.addEventListener('click', goFirst);
  els.btnPrev.addEventListener('click', goPrev);
  els.btnNext.addEventListener('click', goNext);
  els.btnLast.addEventListener('click', goLast);
  els.indicator.addEventListener('click', openJump);
  els.btnZoomIn.addEventListener('click', () => zoomByStep(1));
  els.btnZoomOut.addEventListener('click', () => zoomByStep(-1));
  els.btnFull.addEventListener('click', () => { toggleFullscreen(); });
  els.jumpCancel.addEventListener('click', closeJump);
  els.jumpLayer.addEventListener('click', (event) => {
    if (event.target === els.jumpLayer) closeJump();
  });
  els.jumpForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = Number(els.jumpInput.value);
    if (!Number.isInteger(value) || value < 1 || value > state.pageCount) {
      els.jumpError.textContent = `請輸入 1 至 ${state.pageCount} 之間嘅整數。`;
      return;
    }
    closeJump();
    goToIndex(value - 1);
  });

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('fullscreenchange', () => {
    updateFullLabel();
    setTimeout(layout, 60);
  });
  document.addEventListener('webkitfullscreenchange', () => {
    updateFullLabel();
    setTimeout(layout, 60);
  });

  document.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (!els.landing.hidden) els.landing.classList.add('is-dragover');
  });
  document.addEventListener('dragleave', () => {
    els.landing.classList.remove('is-dragover');
  });
  document.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    els.landing.classList.remove('is-dragover');
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) openFile(file);
  });

  els.bookMount.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
  els.bookMount.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  els.bookMount.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
  els.bookMount.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: false });
  els.bookMount.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('mousemove', onMouseMove, true);
  window.addEventListener('mouseup', onMouseUp, true);

  els.stage.addEventListener('wheel', (event) => {
    if (!state.ready) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      setZoom(state.zoom * (event.deltaY < 0 ? 1.08 : 0.92));
      return;
    }
    if (state.zoom <= 1.001) return;
    event.preventDefault();
    const index = visibleIndexes()[0];
    panBy(index, event.shiftKey ? -event.deltaY : -event.deltaX, event.shiftKey ? 0 : -event.deltaY);
  }, { passive: false });

  const resizeObserver = new ResizeObserver(() => {
    if (!state.flip) return;
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => {
      layout();
      schedulePump();
    }, 80);
  });
  resizeObserver.observe(els.stage);
}

bind();
