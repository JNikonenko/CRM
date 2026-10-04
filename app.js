'use strict';

/* ================= storage ================= */

const STORE_KEY = 'dnevnik.data.v1';
const UI_KEY = 'dnevnik.ui.v1';
const SYNC_KEY = 'dnevnik.sync.v1';
const GIST_FILE = 'dnevnik.json';
const PALETTE = ['#2f5bd3', '#d9622b', '#119a76', '#9445d6', '#c79a13', '#d6336c'];

const storage = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
  del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const now = () => Date.now();

/* ================= dates ================= */

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const DAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const DAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const mondayOf = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)); };
const todayIso = () => iso(new Date());
const shortDate = (s) => { const d = parse(s); return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`; };
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 86400000 + 1) / 7);
}

/* ================= state ================= */

function exampleState() {
  const t = now();
  const projects = [
    { id: uid(), name: 'Работа 1', color: PALETTE[0], order: 0, updatedAt: t },
    { id: uid(), name: 'Работа 2', color: PALETTE[1], order: 1, updatedAt: t },
    { id: uid(), name: 'Доп. проект', color: PALETTE[2], order: 2, updatedAt: t },
  ];
  const d = (n) => iso(addDays(new Date(), n));
  const rows = [
    [0, 'Пример: созвон с командой', d(0), true],
    [0, 'Пример: отчёт за неделю', d(3), false],
    [1, 'Пример: подготовить макеты', d(1), false],
    [1, 'Пример: ответить на письма', d(1), false],
    [2, 'Пример: дедлайн по доп. проекту', d(8), true],
    [2, 'Пример: идея без даты, разобрать позже', null, false],
  ];
  const tasks = rows.map(([p, title, date, important], i) => ({
    id: uid(), title, note: '', projectId: projects[p].id, date, done: false, important,
    dayOrder: i, projOrder: i, example: true, createdAt: t + i, updatedAt: t,
  }));
  return { version: 1, projects, tasks };
}

let state = storage.get(STORE_KEY, null) || exampleState();
let ui = Object.assign({ view: 'week', anchor: todayIso(), hidden: [], defaultProject: null, showDone: false }, storage.get(UI_KEY, {}));
let sync = Object.assign({ token: '', gistId: '', lastSync: 0 }, storage.get(SYNC_KEY, {}));

// tasks created before the backlog existed get a backlog position after the ordered ones
(function migrateBacklog() {
  const undated = state.tasks.filter((t) => !t.date && !t.deleted);
  let next = Math.max(-1, ...undated.map((t) => t.backOrder).filter(Number.isFinite)) + 1;
  undated.filter((t) => !Number.isFinite(t.backOrder)).sort((a, b) => a.createdAt - b.createdAt)
    .forEach((t) => { t.backOrder = next++; });
})();

// drop tombstones older than 30 days
(function purge() {
  const cutoff = now() - 30 * 86400000;
  state.tasks = state.tasks.filter((t) => !(t.deleted && t.updatedAt < cutoff));
  state.projects = state.projects.filter((p) => !(p.deleted && p.updatedAt < cutoff));
})();

const projects = () => state.projects.filter((p) => !p.deleted).sort((a, b) => a.order - b.order);
const projectById = (id) => state.projects.find((p) => p.id === id);
const taskById = (id) => state.tasks.find((t) => t.id === id);
const liveTasks = () => state.tasks.filter((t) => !t.deleted && projectById(t.projectId) && !projectById(t.projectId).deleted);
const visibleTasks = () => liveTasks().filter((t) => !ui.hidden.includes(t.projectId));
const byDayOrder = (a, b) => (a.dayOrder - b.dayOrder) || (a.createdAt - b.createdAt);
const byProjOrder = (a, b) => (a.projOrder - b.projOrder) || (a.createdAt - b.createdAt);
const byBackOrder = (a, b) => ((a.backOrder ?? Infinity) - (b.backOrder ?? Infinity)) || (a.createdAt - b.createdAt);

function save() {
  storage.set(STORE_KEY, state);
  scheduleSync();
}
function saveUi() { storage.set(UI_KEY, ui); }

function touch(obj) { obj.updatedAt = now(); }

function nextOrder(field, filter) {
  const list = liveTasks().filter(filter);
  const values = list.map((t) => t[field]).filter(Number.isFinite);
  return values.length ? Math.max(...values) + 1 : 0;
}

function addTask({ title, projectId, date = null, important = false, note = '', checklist = [] }) {
  const t = {
    id: uid(), title: title.trim(), note, checklist, projectId, date, done: false, important,
    dayOrder: nextOrder('dayOrder', (x) => x.date === date),
    projOrder: nextOrder('projOrder', (x) => x.projectId === projectId),
    backOrder: nextOrder('backOrder', (x) => !x.date),
    createdAt: now(), updatedAt: now(),
  };
  state.tasks.push(t);
  save();
  return t;
}

/* ================= rendering ================= */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');
let sortables = [];
let pendingFocus = null;
let lastCellTap = { key: null, at: 0 };

function taskHtml(t, { showProject = true, showDate = false, rank = null } = {}) {
  const p = projectById(t.projectId);
  const overdue = t.date && !t.done && t.date < todayIso();
  const meta = [];
  if (showProject) meta.push(`<span class="t-proj">${esc(p.name)}</span>`);
  if (showDate) meta.push(t.date ? `<span class="t-date${overdue ? ' overdue' : ''}">${shortDate(t.date)}</span>` : '<span class="t-date">без даты</span>');
  if (t.note) meta.push('<span class="t-note-mark">✎ заметка</span>');
  if (t.checklist && t.checklist.length) {
    const done = t.checklist.filter((c) => c.done).length;
    meta.push(`<span class="t-check${done === t.checklist.length ? ' complete' : ''}">☑ ${done}/${t.checklist.length}</span>`);
  }
  return `<li class="task${t.done ? ' done' : ''}${t.important ? ' important' : ''}" data-id="${t.id}" style="--pc:${esc(p.color)}">
    ${rank !== null ? `<span class="rank">${rank}</span>` : ''}
    <button type="button" class="check" aria-label="${t.done ? 'Вернуть в работу' : 'Отметить выполненной'}"></button>
    <div class="t-body"><div class="t-title">${esc(t.title)}</div>${meta.length ? `<div class="t-meta">${meta.join('')}</div>` : ''}</div>
  </li>`;
}

function quickHtml(attrs, placeholder, withProject = true) {
  const select = withProject
    ? `<select class="quick-project" aria-label="Проект">${projects().map((p) => `<option value="${p.id}"${p.id === ui.defaultProject ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`
    : '';
  return `<form class="quick${withProject ? ' with-project' : ''}" ${attrs}><input type="text" data-quick="${esc(attrs)}" placeholder="${placeholder}" enterkeyhint="done" aria-label="${placeholder}">${select}</form>`;
}

const withoutDone = (list) => (ui.showDone ? list : list.filter((t) => !t.done));

function render() {
  for (const s of sortables) s.destroy();
  sortables = [];

  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === ui.view)));
  renderChips();
  $('#period-nav').hidden = ui.view === 'lists' || ui.view === 'backlog';

  if (ui.view === 'day') renderDay();
  else if (ui.view === 'week') renderWeek();
  else if (ui.view === 'month') renderMonth();
  else if (ui.view === 'backlog') renderBacklog();
  else renderLists();
  renderNotice();

  if (pendingFocus) {
    const input = view.querySelector(`input[data-quick="${CSS.escape(pendingFocus)}"]`);
    if (input) input.focus();
    pendingFocus = null;
  }
}

function renderChips() {
  const ps = projects();
  $('#chips').innerHTML = ps.map((p) =>
    `<button type="button" class="chip" data-project="${p.id}" style="--pc:${esc(p.color)}" aria-pressed="${!ui.hidden.includes(p.id)}">${esc(p.name)}</button>`).join('');
  if (!ps.some((p) => p.id === ui.defaultProject)) ui.defaultProject = ps[0] ? ps[0].id : null;
  $('#show-done').checked = ui.showDone;
}

function renderNotice() {
  const n = $('#notice');
  const today = todayIso();
  const overdue = visibleTasks().filter((t) => t.date && t.date < today && !t.done);
  const examples = state.tasks.filter((t) => t.example && !t.deleted);
  const parts = [];
  if (examples.length) parts.push(`<span>Это примеры задач, чтобы было видно, как всё устроено.</span><button type="button" class="btn small" data-act="clear-examples">Удалить примеры</button>`);
  if (overdue.length && ui.view !== 'lists' && ui.view !== 'backlog') parts.push(`<span>Хвосты с прошлых дней: <b>${overdue.length}</b>.</span><button type="button" class="btn small" data-act="overdue-today">Перенести на сегодня</button>`);
  n.innerHTML = parts.join('<span class="spacer"></span>');
  n.hidden = !parts.length;
}

function renderDay() {
  const d = parse(ui.anchor);
  const key = ui.anchor;
  const today = todayIso();
  const wd = (d.getDay() + 6) % 7;
  const rel = key === today ? 'сегодня' : key === iso(addDays(new Date(), 1)) ? 'завтра' : key === iso(addDays(new Date(), -1)) ? 'вчера' : String(d.getFullYear());
  $('#period-title').innerHTML = `${d.getDate()} ${MONTHS[d.getMonth()]}<small>${rel} · неделя ${isoWeek(d)}</small>`;

  const tasks = visibleTasks();
  const mon = mondayOf(d);
  const strip = [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const x = addDays(mon, i);
    const k = iso(x);
    const left = tasks.filter((t) => t.date === k && !t.done).length;
    const cls = ['ds-day', k === key && 'active', k === today && 'today', i >= 5 && 'weekend'].filter(Boolean).join(' ');
    return `<button type="button" class="${cls}" data-goto="${k}" data-goto-view="day" aria-pressed="${k === key}">
      <span class="ds-name">${DAYS_SHORT[i]}</span><span class="ds-num">${x.getDate()}</span><span class="ds-count">${left || ''}</span></button>`;
  }).join('');

  const list = tasks.filter((t) => t.date === key).sort(byDayOrder);
  const left = list.filter((t) => !t.done).length;
  const cls = ['day', 'day-single', key === today && 'today', wd >= 5 && 'weekend'].filter(Boolean).join(' ');
  view.innerHTML = `<div class="day-view">
    <div class="day-strip">${strip}</div>
    <section class="page"><article class="${cls}">
      <div class="day-head"><span class="day-name">${DAYS[wd]}</span><span class="day-date">${d.getDate()} ${MONTHS[d.getMonth()]}</span>
      <span class="day-count">${list.length ? `осталось ${left} из ${list.length}` : ''}</span></div>
      <ol class="tasks" data-date="${key}">${withoutDone(list).map((t) => taskHtml(t)).join('')}</ol>
      ${quickHtml(`data-date="${key}"`, 'записать задачу…')}
    </article></section>
  </div>`;
  view.querySelectorAll('.tasks').forEach((el) => makeSortable(el, 'day'));
}

function renderWeek() {
  const mon = mondayOf(parse(ui.anchor));
  const sun = addDays(mon, 6);
  const sameMonth = mon.getMonth() === sun.getMonth();
  $('#period-title').innerHTML = `${mon.getDate()}${sameMonth ? '' : ' ' + MONTHS_SHORT[mon.getMonth()]} – ${sun.getDate()} ${MONTHS_SHORT[sun.getMonth()]}<small>неделя ${isoWeek(mon)} · ${sun.getFullYear()}</small>`;

  const tasks = visibleTasks();
  const today = todayIso();
  const dayHtml = (i) => {
    const d = addDays(mon, i);
    const key = iso(d);
    const list = tasks.filter((t) => t.date === key).sort(byDayOrder);
    const left = list.filter((t) => !t.done).length;
    const cls = ['day', key === today && 'today', i >= 5 && 'weekend', key < today && 'past'].filter(Boolean).join(' ');
    return `<article class="${cls}">
      <div class="day-head"><button type="button" class="day-name day-link" data-goto="${key}" data-goto-view="day" title="Открыть день">${DAYS[i]}</button><span class="day-date">${d.getDate()} ${MONTHS[d.getMonth()]}</span>
      <span class="day-count">${list.length ? `${left}/${list.length}` : ''}</span></div>
      <ol class="tasks" data-date="${key}">${withoutDone(list).map((t) => taskHtml(t)).join('')}</ol>
      ${quickHtml(`data-date="${key}"`, 'записать задачу…')}
    </article>`;
  };
  // like a paper diary: Mon–Wed on the left page, Thu–Sun on the right
  view.innerHTML = `<div class="spread">
    <section class="page">${[0, 1, 2].map(dayHtml).join('')}</section>
    <section class="page">${[3, 4, 5, 6].map(dayHtml).join('')}</section>
  </div>`;
  view.querySelectorAll('.tasks').forEach((el) => makeSortable(el, 'day'));
}

function renderMonth() {
  const a = parse(ui.anchor);
  const first = new Date(a.getFullYear(), a.getMonth(), 1);
  const start = mondayOf(first);
  const last = new Date(a.getFullYear(), a.getMonth() + 1, 0);
  const weeks = Math.ceil((((first.getDay() + 6) % 7) + last.getDate()) / 7);
  $('#period-title').innerHTML = `${MONTHS_NOM[a.getMonth()]}<small>${a.getFullYear()}</small>`;

  const tasks = visibleTasks();
  const today = todayIso();
  let cells = '';
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(start, i);
    const key = iso(d);
    const list = tasks.filter((t) => t.date === key).sort(byDayOrder);
    const cls = ['m-cell', d.getMonth() !== a.getMonth() && 'other', key === today && 'today'].filter(Boolean).join(' ');
    cells += `<div class="${cls}" data-cell="${key}">
      <button type="button" class="m-num" data-goto="${key}" data-goto-view="day" title="Открыть день">${d.getDate()}</button>
      <ol class="tasks" data-date="${key}">${withoutDone(list).map((t) => taskHtml(t, { showProject: false })).join('')}</ol>
    </div>`;
  }
  view.innerHTML = `<p class="hint month-hint">Двойное нажатие по дню добавляет задачу.</p><div class="month">
    <div class="m-head">${DAYS_SHORT.map((d) => `<div>${d}</div>`).join('')}</div>
    <div class="m-grid">${cells}</div>
  </div>`;
  view.querySelectorAll('.tasks').forEach((el) => makeSortable(el, 'day'));
}

function renderLists() {
  const tasks = visibleTasks();
  const cols = projects().filter((p) => !ui.hidden.includes(p.id)).map((p) => {
    const all = tasks.filter((t) => t.projectId === p.id).sort(byProjOrder);
    const list = withoutDone(all);
    const left = all.filter((t) => !t.done).length;
    return `<section class="col" data-col="${p.id}" style="--pc:${esc(p.color)}">
      <div class="col-head" title="Перетащите, чтобы поменять порядок проектов"><span class="col-grip" aria-hidden="true">⋮⋮</span><span class="col-name">${esc(p.name)}</span><span class="col-count">${left} в списке</span></div>
      <ol class="tasks" data-project="${p.id}">${list.map((t, i) => taskHtml(t, { showProject: false, showDate: true, rank: i + 1 })).join('')}</ol>
      ${quickHtml(`data-project="${p.id}"`, 'добавить в конец списка…', false)}
    </section>`;
  });
  view.innerHTML = cols.length ? `<div class="lists">${cols.join('')}</div>` : '<p class="empty">Все проекты скрыты фильтром сверху.</p>';
  view.querySelectorAll('.tasks').forEach((el) => makeSortable(el, 'project'));
  const board = view.querySelector('.lists');
  if (board && window.Sortable) {
    sortables.push(new Sortable(board, {
      handle: '.col-head',
      draggable: '.col',
      animation: 150,
      delay: 200,
      delayOnTouchOnly: true,
      ghostClass: 'drag-ghost',
      onEnd: () => reorderProjects([...board.children].map((c) => c.dataset.col)),
    }));
  }
}

// visibleIds is the new order of the shown columns; hidden projects keep their slots
function reorderProjects(visibleIds) {
  const queue = [...visibleIds];
  const next = projects().map((p) => (visibleIds.includes(p.id) ? queue.shift() : p.id));
  next.forEach((id, i) => {
    const p = projectById(id);
    if (p.order !== i) { p.order = i; touch(p); }
  });
  save();
  render();
}

function renderBacklog() {
  const all = visibleTasks().filter((t) => !t.date).sort(byBackOrder);
  const list = withoutDone(all);
  const left = all.filter((t) => !t.done).length;
  view.innerHTML = `<div class="backlog-view"><section class="page">
    <div class="day-head"><span class="day-name">Бэклог</span><span class="day-date">задачи без даты</span>
      <span class="day-count">${left} в списке</span></div>
    <p class="hint backlog-hint">Здесь задачи ждут своего дня. Чтобы запланировать, откройте задачу и поставьте дату.</p>
    <ol class="tasks" data-backlog="1">${list.map((t, i) => taskHtml(t, { rank: i + 1 })).join('')}</ol>
    ${quickHtml('data-backlog="1"', 'добавить в бэклог…')}
  </section></div>`;
  view.querySelectorAll('.tasks').forEach((el) => makeSortable(el, 'backlog'));
}

/* ================= drag & drop ================= */

function makeSortable(el, mode) {
  if (!window.Sortable) return;
  sortables.push(new Sortable(el, {
    group: 'tasks',
    animation: 150,
    delay: 200,
    delayOnTouchOnly: true,
    ghostClass: 'drag-ghost',
    chosenClass: 'chosen',
    filter: '.check',
    preventOnFilter: false,
    onEnd: (evt) => onDrop(evt, mode),
  }));
}

function onDrop(evt, mode) {
  const t = taskById(evt.item.dataset.id);
  if (!t) return;
  const field = { day: 'dayOrder', project: 'projOrder', backlog: 'backOrder' }[mode];
  if (mode === 'day') t.date = evt.to.dataset.date;
  else if (mode === 'project') t.projectId = evt.to.dataset.project;
  touch(t);
  for (const list of new Set([evt.from, evt.to])) {
    [...list.children].forEach((li, i) => {
      const x = taskById(li.dataset.id);
      if (x && x[field] !== i) { x[field] = i; touch(x); }
    });
  }
  save();
  render();
}

/* ================= events ================= */

document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  ui.view = b.dataset.view; saveUi(); render();
});

$('#prev').addEventListener('click', () => shiftPeriod(-1));
$('#next').addEventListener('click', () => shiftPeriod(1));
$('#today').addEventListener('click', () => { ui.anchor = todayIso(); saveUi(); render(); });
function shiftPeriod(dir) {
  const a = parse(ui.anchor);
  ui.anchor = iso(ui.view === 'month' ? new Date(a.getFullYear(), a.getMonth() + dir, 1) : addDays(a, (ui.view === 'day' ? 1 : 7) * dir));
  saveUi(); render();
}

$('#chips').addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (!c) return;
  const id = c.dataset.project;
  ui.hidden = ui.hidden.includes(id) ? ui.hidden.filter((x) => x !== id) : [...ui.hidden, id];
  saveUi(); render();
});
$('#show-done').addEventListener('change', (e) => { ui.showDone = e.target.checked; saveUi(); render(); });

view.addEventListener('click', (e) => {
  const check = e.target.closest('.check');
  if (check) {
    const t = taskById(check.closest('.task').dataset.id);
    t.done = !t.done; touch(t); save(); render();
    if (t.done) toast('Выполнено', 'Вернуть', () => { t.done = false; touch(t); save(); render(); });
    return;
  }
  const go = e.target.closest('[data-goto]');
  if (go) { ui.anchor = go.dataset.goto; ui.view = go.dataset.gotoView || 'week'; saveUi(); render(); return; }
  const li = e.target.closest('.task');
  if (li) { openEditor(taskById(li.dataset.id)); return; }
  // month: double click / double tap on an empty part of a day cell adds a task.
  // Tracked by hand because phones don't fire dblclick reliably.
  const cell = e.target.closest('[data-cell]');
  if (cell) {
    const t = now();
    if (lastCellTap.key === cell.dataset.cell && t - lastCellTap.at < 400) {
      lastCellTap = { key: null, at: 0 };
      if (!projects().length) { openSettings(); return; }
      openEditor(null, cell.dataset.cell);
    } else {
      lastCellTap = { key: cell.dataset.cell, at: t };
    }
  }
});

// picking a project in one add field makes it the default for all of them
view.addEventListener('change', (e) => {
  if (!e.target.matches('.quick-project')) return;
  ui.defaultProject = e.target.value; saveUi();
  view.querySelectorAll('.quick-project').forEach((sel) => { sel.value = ui.defaultProject; });
});

view.addEventListener('submit', (e) => {
  const form = e.target.closest('.quick');
  if (!form) return;
  e.preventDefault();
  const input = form.querySelector('input');
  const title = input.value.trim();
  if (!title) return;
  if (form.dataset.project) addTask({ title, projectId: form.dataset.project });
  else {
    const projectId = form.querySelector('.quick-project').value;
    if (!projectId) { toast('Сначала создайте проект в настройках'); return; }
    ui.defaultProject = projectId; saveUi();
    addTask({ title, projectId, date: form.dataset.date || null });
  }
  pendingFocus = input.dataset.quick;
  render();
});

$('#notice').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'clear-examples') {
    state.tasks.forEach((t) => { if (t.example && !t.deleted) { t.deleted = true; touch(t); } });
    save(); render(); toast('Примеры удалены');
  }
  if (act === 'overdue-today') {
    const today = todayIso();
    let order = nextOrder('dayOrder', (x) => x.date === today);
    visibleTasks().filter((t) => t.date && t.date < today && !t.done).sort(byDayOrder)
      .forEach((t) => { t.date = today; t.dayOrder = order++; touch(t); });
    save(); render(); toast('Перенесено на сегодня');
  }
});

/* ================= editor ================= */

const editor = $('#editor');
let editing = null;

/* checklist inside the editor: edited on a copy, saved with the task */
let draftChecklist = [];
const checklistEl = $('#f-checklist');

function renderChecklist() {
  checklistEl.innerHTML = draftChecklist.map((c) => `<li class="cl-item${c.done ? ' done' : ''}" data-id="${c.id}">
    <span class="cl-handle" aria-hidden="true" title="Перетащить">⋮⋮</span>
    <input type="checkbox" class="cl-done"${c.done ? ' checked' : ''} aria-label="Пункт выполнен">
    <input type="text" class="cl-text" value="${esc(c.text)}" aria-label="Пункт чек-листа">
    <button type="button" class="cl-del" aria-label="Удалить пункт">×</button>
  </li>`).join('');
  updateChecklistCount();
}
function updateChecklistCount() {
  const done = draftChecklist.filter((c) => c.done).length;
  $('#f-check-count').textContent = draftChecklist.length ? `${done} из ${draftChecklist.length}` : '';
}
const draftItem = (el) => draftChecklist.find((c) => c.id === el.closest('.cl-item').dataset.id);

checklistEl.addEventListener('change', (e) => {
  if (!e.target.matches('.cl-done')) return;
  const c = draftItem(e.target);
  c.done = e.target.checked;
  e.target.closest('.cl-item').classList.toggle('done', c.done);
  updateChecklistCount();
});
checklistEl.addEventListener('input', (e) => {
  if (e.target.matches('.cl-text')) draftItem(e.target).text = e.target.value;
});
checklistEl.addEventListener('click', (e) => {
  if (!e.target.matches('.cl-del')) return;
  const c = draftItem(e.target);
  draftChecklist = draftChecklist.filter((x) => x !== c);
  renderChecklist();
});
checklistEl.addEventListener('keydown', (e) => {
  if (!e.target.matches('.cl-text')) return;
  if (e.key === 'Enter') { e.preventDefault(); $('#f-check-new').focus(); }
  if (e.key === 'Backspace' && !e.target.value) {
    e.preventDefault();
    const c = draftItem(e.target);
    draftChecklist = draftChecklist.filter((x) => x !== c);
    renderChecklist();
    $('#f-check-new').focus();
  }
});
$('#f-check-new').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  addDraftItem();
});
function addDraftItem() {
  const input = $('#f-check-new');
  const text = input.value.trim();
  if (!text) return;
  draftChecklist.push({ id: uid(), text, done: false });
  input.value = '';
  renderChecklist();
}
if (window.Sortable) {
  new Sortable(checklistEl, {
    handle: '.cl-handle',
    animation: 150,
    onEnd: () => {
      const order = [...checklistEl.children].map((li) => li.dataset.id);
      draftChecklist.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    },
  });
}

function openEditor(task, presetDate) {
  editing = task || null;
  $('#editor-heading').textContent = task ? 'Задача' : 'Новая задача';
  $('#f-project').innerHTML = projects().map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('#f-title').value = task ? task.title : '';
  $('#f-project').value = task ? task.projectId : (ui.defaultProject || '');
  $('#f-date').value = task ? (task.date || '') : presetDate || (ui.view === 'lists' || ui.view === 'backlog' ? '' : ui.view === 'day' ? ui.anchor : todayIso());
  $('#f-important').checked = task ? !!task.important : false;
  $('#f-note').value = task ? task.note || '' : '';
  draftChecklist = task && task.checklist ? task.checklist.map((c) => ({ ...c })) : [];
  $('#f-check-new').value = '';
  renderChecklist();
  const del = $('#f-delete');
  del.hidden = !task; del.classList.remove('armed'); del.textContent = 'Удалить';
  $('#f-duplicate').hidden = !task;
  editor.showModal();
  if (!task) $('#f-title').focus();
}

$('#btn-new').addEventListener('click', () => {
  if (!projects().length) { openSettings(); return; }
  openEditor(null);
});
$('#f-cancel').addEventListener('click', () => editor.close());
$('#f-nodate').addEventListener('click', () => { $('#f-date').value = ''; });
$('#f-title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#editor-form').requestSubmit(); }
});

// writes the editor form into the task (new or existing); returns it, or null if the title is empty
function saveEditor() {
  const title = $('#f-title').value.trim();
  if (!title) { $('#f-title').focus(); return null; }
  addDraftItem(); // a typed but not yet added item is kept too
  const data = {
    title,
    projectId: $('#f-project').value,
    date: $('#f-date').value || null,
    important: $('#f-important').checked,
    note: $('#f-note').value.trim(),
    checklist: draftChecklist.map((c) => ({ ...c, text: c.text.trim() })).filter((c) => c.text),
  };
  if (editing) {
    if (editing.date && !data.date) editing.backOrder = nextOrder('backOrder', (x) => !x.date && x !== editing);
    if (editing.date !== data.date) editing.dayOrder = nextOrder('dayOrder', (x) => x.date === data.date && x !== editing);
    if (editing.projectId !== data.projectId) editing.projOrder = nextOrder('projOrder', (x) => x.projectId === data.projectId && x !== editing);
    Object.assign(editing, data);
    delete editing.example;
    touch(editing);
    save();
    return editing;
  }
  return addTask(data);
}

$('#editor-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!saveEditor()) return;
  editor.close();
  render();
});

// saves the open task, then makes a copy right below it and opens the copy
$('#f-duplicate').addEventListener('click', () => {
  const t = saveEditor();
  if (!t) return;
  const after = (v) => (Number.isFinite(v) ? v + 0.5 : v);
  const copy = {
    ...t,
    id: uid(),
    done: false,
    checklist: (t.checklist || []).map((c) => ({ ...c, id: uid(), done: false })),
    dayOrder: after(t.dayOrder),
    projOrder: after(t.projOrder),
    backOrder: after(t.backOrder),
    createdAt: now(),
    updatedAt: now(),
  };
  delete copy.example;
  delete copy.deleted;
  state.tasks.push(copy);
  save();
  editor.close();
  render();
  openEditor(copy);
  $('#editor-heading').textContent = 'Копия задачи';
  toast('Копия создана: можно поменять дату или проект');
});

$('#f-delete').addEventListener('click', (e) => {
  const b = e.currentTarget;
  if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Точно удалить?'; return; }
  const t = editing;
  t.deleted = true; touch(t); save();
  editor.close(); render();
  toast('Задача удалена', 'Отменить', () => { t.deleted = false; touch(t); save(); render(); });
});

/* ================= settings ================= */

const settings = $('#settings');

function openSettings() {
  renderProjectSettings();
  $('#s-token').value = sync.token;
  setSyncStatus();
  settings.showModal();
}

function renderProjectSettings() {
  $('#s-projects').innerHTML = projects().map((p) => `<div class="s-proj" data-id="${p.id}">
    <input type="color" value="${esc(p.color)}" aria-label="Цвет проекта">
    <input type="text" value="${esc(p.name)}" aria-label="Название проекта">
    <button type="button" class="btn ghost small" data-move="-1" aria-label="Выше">↑</button>
    <button type="button" class="btn danger small" data-del>Удалить</button>
  </div>`).join('') || '<p class="hint">Пока нет проектов.</p>';
}

$('#btn-settings').addEventListener('click', openSettings);
$('#s-close').addEventListener('click', () => settings.close());
settings.addEventListener('close', render);

$('#s-projects').addEventListener('change', (e) => {
  const row = e.target.closest('.s-proj');
  const p = projectById(row.dataset.id);
  if (e.target.type === 'color') p.color = e.target.value;
  else p.name = e.target.value.trim() || p.name;
  touch(p); save();
});
$('#s-projects').addEventListener('click', (e) => {
  const row = e.target.closest('.s-proj');
  if (!row) return;
  const p = projectById(row.dataset.id);
  if (e.target.closest('[data-move]')) {
    const ps = projects();
    const i = ps.indexOf(p);
    if (i > 0) { [ps[i - 1], ps[i]] = [ps[i], ps[i - 1]]; ps.forEach((x, j) => { if (x.order !== j) { x.order = j; touch(x); } }); save(); renderProjectSettings(); }
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    if (!del.classList.contains('armed')) {
      const n = liveTasks().filter((t) => t.projectId === p.id).length;
      del.classList.add('armed'); del.textContent = n ? `Удалить с ${n} задач?` : 'Точно?';
      return;
    }
    p.deleted = true; touch(p);
    liveTasks().filter((t) => t.projectId === p.id).forEach((t) => { t.deleted = true; touch(t); });
    save(); renderProjectSettings();
  }
});
$('#s-add-project').addEventListener('click', () => {
  const ps = projects();
  state.projects.push({ id: uid(), name: `Проект ${ps.length + 1}`, color: PALETTE[ps.length % PALETTE.length], order: ps.length, updatedAt: now() });
  save(); renderProjectSettings();
  const inputs = $('#s-projects').querySelectorAll('input[type="text"]');
  inputs[inputs.length - 1].select();
});

$('#s-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dnevnik-${todayIso()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#s-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.tasks) || !Array.isArray(data.projects)) throw new Error('bad');
    state = merge(state, data);
    save(); renderProjectSettings(); toast('Копия загружена и объединена с текущими данными');
  } catch {
    toast('Не получилось прочитать файл: нужен JSON, скачанный из Гори');
  }
  e.target.value = '';
});

/* ================= sync via GitHub Gist ================= */

function mergeList(a = [], b = []) {
  const map = new Map();
  for (const x of [...a, ...b]) {
    const cur = map.get(x.id);
    if (!cur || (x.updatedAt || 0) > (cur.updatedAt || 0)) map.set(x.id, x);
  }
  return [...map.values()];
}
const signature = (s) => [...s.projects, ...s.tasks].map((x) => `${x.id}:${x.updatedAt}`).sort().join(',');
function merge(a, b) {
  return { version: 1, projects: mergeList(a.projects, b.projects), tasks: mergeList(a.tasks, b.tasks) };
}

async function gh(path, opts = {}) {
  const res = await fetch('https://api.github.com' + path, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${sync.token}`,
      Accept: 'application/vnd.github+json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store', // the browser must not answer with a stale copy of the gist
  });
  if (!res.ok) {
    const msg = res.status === 401 ? 'токен не подошёл' : res.status === 404 ? 'данные не найдены (проверьте права токена: нужна галочка gist)' : `ошибка GitHub ${res.status}`;
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

async function readGist(id) {
  const g = await gh(`/gists/${id}`);
  const f = g.files[GIST_FILE];
  if (!f) return null;
  return JSON.parse(f.truncated ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content);
}

// Every device must use the same gist. Earlier versions created a new gist on each
// device that connected without an ID, so find all of ours, keep the oldest one and
// fold the others into it.
let gistsChecked = false;
async function pickSharedGist() {
  const list = await gh('/gists?per_page=100');
  const ours = list.filter((g) => g.files && g.files[GIST_FILE])
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (!ours.length) return [];
  if (sync.gistId !== ours[0].id) { sync.gistId = ours[0].id; storage.set(SYNC_KEY, sync); }
  const extras = ours.slice(1).map((g) => g.id);
  for (const id of extras) {
    const data = await readGist(id);
    if (data) state = merge(state, data);
  }
  return extras;
}

let syncTimer = null;
let syncing = false;
let syncAgain = false;
let syncError = '';

function scheduleSync() {
  if (!sync.token) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 1500);
}

async function syncNow() {
  if (!sync.token) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true; syncError = ''; setSyncStatus();
  try {
    const before = JSON.stringify(state);
    let extras = [];
    if (!gistsChecked) { extras = await pickSharedGist(); gistsChecked = true; }
    const remote = sync.gistId ? await readGist(sync.gistId) : null;
    if (remote) state = merge(state, remote);
    storage.set(STORE_KEY, state);
    if (JSON.stringify(state) !== before && !document.querySelector('dialog[open]') && !view.contains(document.activeElement)) render();

    const body = { files: { [GIST_FILE]: { content: JSON.stringify(state) } } };
    if (sync.gistId) {
      if (!remote || signature(remote) !== signature(state)) await gh(`/gists/${sync.gistId}`, { method: 'PATCH', body });
    } else {
      const g = await gh('/gists', { method: 'POST', body: { description: 'Гори: данные планера', public: false, ...body } });
      sync.gistId = g.id;
    }
    // duplicates are merged into the shared gist above, so they can go
    for (const id of extras) await gh(`/gists/${id}`, { method: 'DELETE' }).catch(() => {});
    sync.lastSync = now();
    storage.set(SYNC_KEY, sync);
  } catch (err) {
    syncError = err.message || 'нет связи';
  } finally {
    syncing = false;
    setSyncStatus();
    if (syncAgain) { syncAgain = false; scheduleSync(); }
  }
}

function setSyncStatus() {
  const dot = $('#sync-dot');
  const status = $('#s-sync-status');
  let text;
  dot.className = 'sync-dot';
  if (!sync.token) text = 'Синхронизация выключена: данные хранятся только в этом браузере.';
  else if (syncing) { dot.classList.add('busy'); text = 'Синхронизация…'; }
  else if (syncError) { dot.classList.add('err'); text = `Не удалось синхронизировать: ${syncError}.`; }
  else {
    dot.classList.add('ok');
    const t = sync.lastSync ? new Date(sync.lastSync) : null;
    text = t ? `Синхронизировано в ${pad(t.getHours())}:${pad(t.getMinutes())}. Хранилище: ${sync.gistId.slice(0, 7)}` : 'Подключено.';
  }
  dot.title = text;
  status.textContent = text;
}

$('#s-sync').addEventListener('click', () => {
  sync.token = $('#s-token').value.trim();
  storage.set(SYNC_KEY, sync);
  gistsChecked = false;
  syncNow();
});
$('#s-unsync').addEventListener('click', () => {
  sync = { token: '', gistId: sync.gistId, lastSync: 0 };
  storage.set(SYNC_KEY, sync);
  $('#s-token').value = '';
  setSyncStatus();
});

$('#sync-dot').addEventListener('click', () => { if (sync.token) { gistsChecked = false; syncNow(); } else openSettings(); });

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 120000);

/* ================= toast ================= */

let toastTimer = null;
function toast(text, actionLabel, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(text)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ''}`;
  el.hidden = false;
  if (actionLabel) el.querySelector('button').onclick = () => { el.hidden = true; action(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

/* ================= boot ================= */

storage.set(STORE_KEY, state);
render();
setSyncStatus();
syncNow();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is optional */ });
}
