/* ============================================================
   Тело — дневник тренировок и питания
   Чистый JS, без сборки. Данные хранятся в localStorage.
   Контракт обмена с Клодом — JSON (см. CLAUDE_PLAN_FORMAT.md).
   ============================================================ */
(function () {
  'use strict';

  var STORE_KEY = 'telo.diary.v1';
  var SCHEMA = 'fitness-diary';
  var VERSION = 1;

  var WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
  var DOW_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  var MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

  /* ---------- мелкие утилиты ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function localISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayISO() { return localISO(new Date()); }
  function parseISO(s) { var p = String(s).split('-'); return new Date(+p[0], (+p[1] || 1) - 1, +p[2] || 1); }
  function addDaysISO(iso, n) { var d = parseISO(iso); d.setDate(d.getDate() + n); return localISO(d); }
  function dowName(iso) { return WEEKDAYS[parseISO(iso).getDay()]; }
  function dowShort(iso) { return DOW_SHORT[parseISO(iso).getDay()]; }
  function dayNum(iso) { return parseISO(iso).getDate(); }
  function fmtDate(iso) { var d = parseISO(iso); return d.getDate() + ' ' + MONTHS[d.getMonth()]; }
  function uid() { return 'e' + Math.random().toString(36).slice(2, 9); }
  function numOrNull(v) {
    if (v === '' || v === null || v === undefined) return null;
    var n = parseFloat(String(v).replace(',', '.'));
    return isNaN(n) ? null : n;
  }
  function strOrNull(v) { return (v === null || v === undefined || v === '') ? null : String(v); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function fmtNum(v) {
    if (v == null || v === '') return '—';
    var s = (Math.round(v * 100) / 100).toString();
    return s.replace('.', ',');
  }

  /* ---------- состояние ---------- */
  function defaultState() {
    return {
      weeks: {},
      currentWeekStart: null,
      seededTrends: {}, // date -> {weightKg, waistCm} (история для графиков с других устройств)
      settings: { prepDefault: 5, restDefault: 120, autoStartRest: true, sound: true, vibrate: true, alarmMode: true, keepAwake: true }
    };
  }
  var state = load();
  var ui = { tab: 'today', selectedDate: null, nutriOpen: false };
  var prevTab = null;

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultState();
      var s = JSON.parse(raw);
      var d = defaultState();
      s.weeks = s.weeks || {};
      s.seededTrends = s.seededTrends || {};
      s.settings = Object.assign(d.settings, s.settings || {});
      if (!s.currentWeekStart) s.currentWeekStart = null;
      return s;
    } catch (e) { return defaultState(); }
  }
  var saveTimer = null;
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {} }
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 250); }

  function currentWeek() { return state.currentWeekStart ? state.weeks[state.currentWeekStart] : null; }
  function weekStarts() { return Object.keys(state.weeks).sort(); }
  function dayIndexByDate(week, iso) {
    if (!week) return -1;
    for (var i = 0; i < week.days.length; i++) if (week.days[i].date === iso) return i;
    return -1;
  }
  function ensureSelected() {
    var wk = currentWeek();
    if (!wk) { ui.selectedDate = null; return; }
    if (ui.selectedDate && dayIndexByDate(wk, ui.selectedDate) >= 0) return;
    var t = todayISO();
    ui.selectedDate = dayIndexByDate(wk, t) >= 0 ? t : wk.days[0].date;
  }

  /* ---------- нормализация входящего плана ---------- */
  function normExercise(e) {
    var sets = [];
    if (Array.isArray(e.sets)) {
      sets = e.sets.map(function (s) {
        return {
          reps: numOrNull(s.reps), weight: numOrNull(s.weight),
          rpe: numOrNull(s.rpe), tut: numOrNull(s.tut), done: !!s.done
        };
      });
    }
    var targetSets = numOrNull(e.targetSets);
    if (targetSets == null && typeof e.sets === 'number') targetSets = e.sets;
    if (!sets.length && targetSets) {
      for (var i = 0; i < targetSets; i++) sets.push({ reps: null, weight: null, rpe: null, tut: null, done: false });
    }
    return {
      id: e.id || uid(),
      name: String(e.name || 'Упражнение'),
      targetSets: targetSets,
      targetReps: strOrNull(e.targetReps != null ? e.targetReps : e.reps),
      targetWeight: numOrNull(e.targetWeight != null ? e.targetWeight : e.weight),
      targetRpe: numOrNull(e.targetRpe != null ? e.targetRpe : e.rpe),
      tut: numOrNull(e.tut),                                                   // время под нагрузкой, сек/подход
      rest: numOrNull(e.rest),                                                 // отдых между подходами, сек
      restAfter: numOrNull(e.restAfter != null ? e.restAfter : e.restBetweenExercises), // отдых между упражнениями, сек
      prep: numOrNull(e.prep),                                                 // «приготовься», сек (необязательно)
      tempo: strOrNull(e.tempo),
      notes: strOrNull(e.notes),
      sets: sets
    };
  }
  function normMeal(m) {
    var items = [];
    if (Array.isArray(m.items)) items = m.items.map(String);
    else if (typeof m.items === 'string') items = [m.items];
    return { name: String(m.name || 'Приём'), items: items, kcal: numOrNull(m.kcal) };
  }
  function normDay(d, idx, startDate) {
    var date = d.date || addDaysISO(startDate, idx);
    var t = d.training || {};
    var n = d.nutrition || {};
    var exs = Array.isArray(t.exercises) ? t.exercises.map(normExercise) : [];
    var body = d.body || {};
    return {
      date: date,
      weekday: d.weekday || dowName(date),
      training: {
        title: strOrNull(t.title) || (t.isRestDay ? 'День отдыха' : 'Тренировка'),
        isRestDay: !!t.isRestDay || (exs.length === 0 && /отдых|rest/i.test(t.title || '')),
        notes: strOrNull(t.notes),
        exercises: exs
      },
      nutrition: {
        title: strOrNull(n.title),
        summary: n.summary ? {
          kcal: numOrNull(n.summary.kcal), protein: numOrNull(n.summary.protein),
          carbs: numOrNull(n.summary.carbs), fat: numOrNull(n.summary.fat)
        } : null,
        meals: Array.isArray(n.meals) ? n.meals.map(normMeal) : [],
        notes: strOrNull(n.notes)
      },
      body: { weightKg: numOrNull(body.weightKg), waistCm: numOrNull(body.waistCm) },
      userNote: strOrNull(d.userNote)
    };
  }
  function itemText(it) {
    if (it == null) return '';
    if (typeof it === 'string') return it.trim();
    if (typeof it === 'object') {
      var name = it.name || it.item || it.title || '';
      var qty = it.qty != null ? it.qty : (it.quantity != null ? it.quantity : '');
      var unit = it.unit || '';
      return (name + (qty !== '' ? ' — ' + qty + (unit ? ' ' + unit : '') : '')).trim();
    }
    return String(it);
  }
  function normShopping(raw) {
    var src = raw.shopping || (raw.week && raw.week.shopping);
    if (!Array.isArray(src) || !src.length) return [];
    if (typeof src[0] === 'object' && src[0] && (src[0].items || src[0].category || src[0].name && Array.isArray(src[0].items))) {
      return src.map(function (g) {
        return { category: strOrNull(g.category) || strOrNull(g.name), items: (g.items || []).map(itemText).filter(Boolean) };
      }).filter(function (g) { return g.items.length; });
    }
    return [{ category: null, items: src.map(itemText).filter(Boolean) }];
  }
  function normalizeDoc(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('Файл пустой или не JSON.');
    if (!Array.isArray(raw.days) || !raw.days.length) throw new Error('Не вижу список дней (поле "days").');
    var week = raw.week || {};
    var startDate = week.startDate || raw.days[0].date;
    if (!startDate) throw new Error('Не указана дата начала недели и нет дат у дней.');
    var days = raw.days.map(function (d, i) { return normDay(d, i, startDate); });
    var athlete = raw.athlete || {};
    return {
      schema: SCHEMA, version: VERSION,
      week: {
        label: strOrNull(week.label) || ('Неделя с ' + fmtDate(startDate)),
        startDate: startDate,
        goal: strOrNull(week.goal)
      },
      athlete: {
        name: strOrNull(athlete.name),
        targets: athlete.targets ? {
          weightKg: numOrNull(athlete.targets.weightKg),
          waistCm: numOrNull(athlete.targets.waistCm)
        } : null
      },
      days: days,
      shopping: normShopping(raw),
      shoppingChecked: raw.shoppingChecked || {}
    };
  }

  function weekHasData(wk) {
    if (!wk) return false;
    for (var i = 0; i < wk.days.length; i++) {
      var d = wk.days[i];
      if (d.body.weightKg != null || d.body.waistCm != null) return true;
      for (var j = 0; j < d.training.exercises.length; j++) {
        var sets = d.training.exercises[j].sets;
        for (var k = 0; k < sets.length; k++) if (sets[k].done || sets[k].reps != null || sets[k].weight != null) return true;
      }
    }
    return false;
  }

  function importData(raw) {
    if (raw && raw.weeks && typeof raw.weeks === 'object' && !Array.isArray(raw.days)) {
      if (!confirm('Это резервная копия. Заменить все текущие данные?')) return;
      state.weeks = {};
      Object.keys(raw.weeks).forEach(function (k) { try { state.weeks[k] = normalizeDoc(raw.weeks[k]); } catch (e) {} });
      state.seededTrends = raw.seededTrends || {};
      var ks = weekStarts();
      state.currentWeekStart = ks[ks.length - 1] || null;
      ui.selectedDate = null; ensureSelected(); save();
      toast('Копия восстановлена', 'good'); ui.tab = 'today'; render();
      return;
    }
    var doc = normalizeDoc(raw);
    var start = doc.week.startDate;
    var existing = state.weeks[start];
    if (existing && weekHasData(existing)) {
      if (!confirm('На эту неделю уже есть записи. Заменить план новым? Введённый факт по этой неделе будет потерян.')) return;
    }
    state.weeks[start] = doc;
    state.currentWeekStart = start;
    if (Array.isArray(raw.trends)) {
      raw.trends.forEach(function (t) {
        if (!t || !t.date) return;
        state.seededTrends[t.date] = { weightKg: numOrNull(t.weightKg), waistCm: numOrNull(t.waistCm) };
      });
    }
    ui.selectedDate = null; ensureSelected(); save();
    toast('План загружен: ' + doc.week.label, 'good');
    ui.tab = 'today'; render();
  }

  /* ---------- экспорт ---------- */
  function allTrends() {
    var map = {};
    Object.keys(state.seededTrends).forEach(function (date) {
      var t = state.seededTrends[date];
      map[date] = { date: date, weightKg: t.weightKg != null ? t.weightKg : null, waistCm: t.waistCm != null ? t.waistCm : null };
    });
    weekStarts().forEach(function (ws) {
      state.weeks[ws].days.forEach(function (d) {
        if (d.body.weightKg != null || d.body.waistCm != null) {
          map[d.date] = { date: d.date, weightKg: d.body.weightKg, waistCm: d.body.waistCm };
        }
      });
    });
    return Object.keys(map).sort().map(function (k) { return map[k]; });
  }
  function buildExport(wk) {
    var doc = JSON.parse(JSON.stringify(wk));
    doc.schema = SCHEMA; doc.version = VERSION;
    doc.exportedAt = new Date().toISOString();
    doc.trends = allTrends();
    return doc;
  }
  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (res, rej) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta); res();
      } catch (e) { rej(e); }
    });
  }

  /* ---------- "прошлый раз" и объём ---------- */
  function normName(s) { return String(s || '').trim().toLowerCase(); }
  function lastPerformance(name, beforeDate) {
    var target = normName(name), best = null;
    weekStarts().forEach(function (ws) {
      state.weeks[ws].days.forEach(function (d) {
        if (d.date >= beforeDate) return;
        d.training.exercises.forEach(function (ex) {
          if (normName(ex.name) !== target) return;
          var done = ex.sets.filter(function (s) { return s.done || s.reps != null || s.weight != null; });
          if (!done.length) return;
          if (!best || d.date > best.date) best = { date: d.date, sets: done };
        });
      });
    });
    return best;
  }
  function setsSummary(sets) {
    return sets.map(function (s) {
      var w = s.weight != null ? fmtNum(s.weight) : '—';
      var r = s.reps != null ? s.reps : '—';
      return w + '×' + r;
    }).join(', ');
  }

  /* ---------- рендер ---------- */
  var view = $('#view');

  function render(keepScroll) {
    var y = window.scrollY;
    ensureSelected();
    var html;
    if (ui.tab === 'week') html = viewWeek();
    else if (ui.tab === 'data') html = viewData();
    else { ui.tab = 'today'; html = viewToday(); }
    view.innerHTML = html;
    var tabs = document.querySelectorAll('#tabbar .tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === ui.tab);
    if (keepScroll && ui.tab === prevTab) window.scrollTo(0, y); else window.scrollTo(0, 0);
    prevTab = ui.tab;
  }

  function appbarHTML(wk, sub) {
    return '<header class="appbar">' +
      '<div class="eyebrow">' + esc(wk ? wk.week.label : 'Тело') + '</div>' +
      '<h1>' + esc(sub) + '</h1>' +
      (wk && wk.week.goal ? '<div class="goal">' + esc(wk.week.goal) + '</div>' : '') +
      '</header>';
  }
  function emptyHTML(title, text, btn) {
    return '<div class="empty fade-in"><div class="big">🏋️</div><h2>' + esc(title) + '</h2><p>' + esc(text) + '</p>' + (btn || '') + '</div>';
  }

  /* --- Сегодня --- */
  function viewToday() {
    var wk = currentWeek();
    if (!wk) {
      return appbarHTML(null, 'Сегодня') +
        emptyHTML('Плана пока нет', 'Загрузи JSON-план от Клода во вкладке «Данные» — и тренировка на сегодня появится здесь.',
          '<button class="btn accent" data-act="tab" data-tab="data">Загрузить план</button>');
    }
    var di = dayIndexByDate(wk, ui.selectedDate);
    var day = wk.days[di];
    var h = appbarHTML(wk, dowName(day.date) + ', ' + fmtDate(day.date));
    h += dayStripHTML(wk);

    h += '<div class="metrics">' +
      metricHTML(di, 'weightKg', 'Вес утром', 'кг', day.body.weightKg) +
      metricHTML(di, 'waistCm', 'Талия утром', 'см', day.body.waistCm) +
      '</div>';

    if (day.training.isRestDay) {
      h += '<div class="card rest-day"><div class="big">😴</div><div style="font-weight:800;font-size:18px;color:var(--text);margin-top:6px">День отдыха</div>' +
        (day.training.notes ? '<div style="margin-top:6px">' + esc(day.training.notes) + '</div>' : '') + '</div>';
    } else if (!day.training.exercises.length) {
      h += '<div class="card"><div class="empty" style="padding:20px">На этот день упражнений нет.</div></div>';
    } else {
      h += '<div class="section-title">' + esc(day.training.title || 'Тренировка') + '</div>';
      if (day.training.notes) h += '<div class="card flat ex-note" style="margin:-2px 2px 10px">' + esc(day.training.notes) + '</div>';
      day.training.exercises.forEach(function (ex) { h += exerciseHTML(di, ex, day.date); });
    }
    h += nutritionHTML(day.nutrition);

    h += '<div class="section-title">Заметки дня</div><div class="card">' +
      '<textarea class="daynote" data-act="notef" data-d="' + di + '" rows="4" ' +
      'placeholder="Как прошла тренировка? Что по питанию — что сделал/не сделал, сколько съел?">' +
      esc(day.userNote || '') + '</textarea></div>';
    return h;
  }

  function dayStripHTML(wk) {
    var h = '<nav class="daystrip">';
    wk.days.forEach(function (d) {
      var cls = 'day-pill';
      if (d.date === ui.selectedDate) cls += ' sel';
      if (d.date === todayISO()) cls += ' today';
      if (d.training.isRestDay) cls += ' rest';
      else if (d.training.exercises.length) cls += ' has';
      h += '<button class="' + cls + '" data-act="selday" data-date="' + d.date + '">' +
        '<span class="dow">' + dowShort(d.date) + '</span>' +
        '<span class="dnum">' + dayNum(d.date) + '</span>' +
        '<span class="dot"></span></button>';
    });
    return h + '</nav>';
  }

  function metricHTML(di, field, label, unit, val) {
    return '<div class="metric"><label>' + label + '</label><div class="field">' +
      '<input inputmode="decimal" data-act="bodyf" data-d="' + di + '" data-f="' + field + '" placeholder="—" value="' + (val == null ? '' : esc(val)) + '">' +
      '<span class="unit">' + unit + '</span></div></div>';
  }

  function exerciseHTML(di, ex, date) {
    var doneCount = ex.sets.filter(function (s) { return s.done; }).length;
    var total = ex.sets.length;
    var allDone = total > 0 && doneCount === total;

    var badges = '';
    var plan = [];
    if (ex.targetSets) plan.push(ex.targetSets + '×' + (ex.targetReps || '?'));
    else if (ex.targetReps) plan.push(ex.targetReps + ' повт');
    if (plan.length) badges += '<span class="badge accent">' + esc(plan.join(' ')) + '</span>';
    if (ex.targetWeight != null) badges += '<span class="badge">' + fmtNum(ex.targetWeight) + ' кг</span>';
    if (ex.targetRpe != null) badges += '<span class="badge">RPE ' + fmtNum(ex.targetRpe) + '</span>';
    if (ex.tut != null) badges += '<span class="badge tut">TUT ' + ex.tut + 'с</span>';
    if (ex.tempo) badges += '<span class="badge">темп ' + esc(ex.tempo) + '</span>';
    if (ex.rest != null) badges += '<span class="badge">между подх. ' + ex.rest + 'с</span>';
    if (ex.restAfter != null) badges += '<span class="badge">между упр. ' + ex.restAfter + 'с</span>';

    var last = lastPerformance(ex.name, date);
    var lastHTML = last ? '<div class="ex-last"><b>Прошлый раз (' + fmtDate(last.date) + '):</b> ' + esc(setsSummary(last.sets)) + '</div>' : '';

    var h = '<div class="ex-card fade-in">' +
      '<div class="ex-head"><div class="ex-title"><h3>' + esc(ex.name) + '</h3>' +
      '<span class="ex-progress' + (allDone ? ' done' : '') + '">' + doneCount + '/' + total + '</span></div>' +
      (badges ? '<div class="badges">' + badges + '</div>' : '') +
      (ex.notes ? '<div class="ex-note">' + esc(ex.notes) + '</div>' : '') +
      lastHTML + '</div>';

    h += '<div class="sets"><div class="set-row head"><span class="sh-num"></span><span>повт</span><span>кг</span><span>rpe</span><span>✓</span><span></span></div>';
    ex.sets.forEach(function (s, si) {
      h += '<div class="set-row' + (s.done ? ' is-done' : '') + '">' +
        '<button class="set-no start" data-act="start-set" data-d="' + di + '" data-ex="' + ex.id + '" data-s="' + si + '" title="Начать подход">▶</button>' +
        cellHTML(di, ex.id, si, 'reps', s.reps, ex.targetReps || '') +
        cellHTML(di, ex.id, si, 'weight', s.weight, ex.targetWeight != null ? fmtNum(ex.targetWeight) : '') +
        cellHTML(di, ex.id, si, 'rpe', s.rpe, ex.targetRpe != null ? fmtNum(ex.targetRpe) : '') +
        '<button class="btn-done' + (s.done ? ' on' : '') + '" data-act="done" data-d="' + di + '" data-ex="' + ex.id + '" data-s="' + si + '" aria-label="Выполнено">✓</button>' +
        '<button class="btn-del" data-act="delset" data-d="' + di + '" data-ex="' + ex.id + '" data-s="' + si + '" aria-label="Удалить подход">×</button>' +
        '</div>';
    });
    h += '</div>';
    h += '<div class="set-actions">' +
      '<button class="btn small start" data-act="start-next" data-d="' + di + '" data-ex="' + ex.id + '">▶ Начать подход</button>' +
      '<button class="btn small ghost" data-act="addset" data-d="' + di + '" data-ex="' + ex.id + '">+ подход</button>' +
      '<button class="btn small ghost" data-act="rest" data-sec="' + (ex.rest || state.settings.restDefault) + '" data-name="' + esc(ex.name) + '">⏱ отдых</button>' +
      '</div></div>';
    return h;
  }
  function cellHTML(di, exId, si, field, val, ph) {
    var mode = field === 'reps' ? 'numeric' : 'decimal';
    return '<input class="cell" inputmode="' + mode + '" data-act="setf" data-d="' + di + '" data-ex="' + exId + '" data-s="' + si + '" data-f="' + field + '" placeholder="' + esc(ph) + '" value="' + (val == null ? '' : esc(val)) + '">';
  }

  function nutritionHTML(n) {
    if (!n || (!n.meals.length && !n.summary && !n.title && !n.notes)) return '';
    var h = '<details class="nutri"' + (ui.nutriOpen ? ' open' : '') + '><summary>🍽 ' + esc(n.title || 'Питание') + '<span class="chev">▾</span></summary>';
    if (n.summary) {
      var s = n.summary, m = [];
      if (s.kcal != null) m.push('<span class="macro"><b>' + fmtNum(s.kcal) + '</b> ккал</span>');
      if (s.protein != null) m.push('<span class="macro">Б <b>' + fmtNum(s.protein) + '</b></span>');
      if (s.carbs != null) m.push('<span class="macro">У <b>' + fmtNum(s.carbs) + '</b></span>');
      if (s.fat != null) m.push('<span class="macro">Ж <b>' + fmtNum(s.fat) + '</b></span>');
      if (m.length) h += '<div class="macros">' + m.join('') + '</div>';
    }
    n.meals.forEach(function (meal) {
      h += '<div class="meal">' + (meal.kcal != null ? '<span class="kcal">' + fmtNum(meal.kcal) + ' ккал</span>' : '') + '<h4>' + esc(meal.name) + '</h4>';
      if (meal.items.length) h += '<ul>' + meal.items.map(function (it) { return '<li>' + esc(it) + '</li>'; }).join('') + '</ul>';
      h += '</div>';
    });
    if (n.notes) h += '<div class="meal" style="color:var(--muted)">' + esc(n.notes) + '</div>';
    return h + '</details>';
  }

  /* --- Неделя (дни + покупки + динамика) --- */
  function viewWeek() {
    var wk = currentWeek();
    if (!wk) return appbarHTML(null, 'Неделя') + emptyHTML('Плана пока нет', 'Загрузи план во вкладке «Данные».',
      '<button class="btn accent" data-act="tab" data-tab="data">Загрузить план</button>');
    var h = appbarHTML(wk, 'Неделя');
    wk.days.forEach(function (d) {
      var isToday = d.date === todayISO();
      var sub, ring = '';
      if (d.training.isRestDay) { sub = 'День отдыха'; }
      else if (!d.training.exercises.length) { sub = 'Нет упражнений'; }
      else {
        var totalSets = 0, doneSets = 0;
        d.training.exercises.forEach(function (ex) { totalSets += ex.sets.length; doneSets += ex.sets.filter(function (s) { return s.done; }).length; });
        sub = d.training.exercises.length + ' упр · ' + doneSets + '/' + totalSets + ' подходов';
        ring = ringHTML(totalSets ? doneSets / totalSets : 0);
      }
      h += '<button class="wk-day' + (isToday ? ' today' : '') + '" data-act="selday" data-date="' + d.date + '" data-go="today">' +
        '<div class="wk-date"><div class="dow">' + dowShort(d.date) + '</div><div class="dnum">' + dayNum(d.date) + '</div></div>' +
        '<div class="wk-main"><div class="t">' + esc(d.training.title) + '</div><div class="s">' + esc(sub) + '</div></div>' +
        (ring || '<div class="ring"></div>') + '</button>';
    });

    if (wk.shopping && wk.shopping.length) h += shoppingHTML(wk);

    var trends = allTrends();
    var targets = wk.athlete && wk.athlete.targets ? wk.athlete.targets : null;
    var w = trends.filter(function (t) { return t.weightKg != null; }).map(function (t) { return { date: t.date, value: t.weightKg }; });
    var wa = trends.filter(function (t) { return t.waistCm != null; }).map(function (t) { return { date: t.date, value: t.waistCm }; });
    if (w.length || wa.length) {
      h += '<div class="section-title">Динамика</div>';
      h += chartCardHTML('Вес', 'кг', w, targets ? targets.weightKg : null);
      h += chartCardHTML('Талия', 'см', wa, targets ? targets.waistCm : null);
    }
    return h;
  }
  function ringHTML(frac) {
    var r = 15, c = 2 * Math.PI * r, off = c * (1 - frac);
    var col = frac >= 1 ? 'var(--accent)' : 'var(--accent-2)';
    return '<svg class="ring" viewBox="0 0 34 34">' +
      '<circle cx="17" cy="17" r="' + r + '" fill="none" stroke="var(--line)" stroke-width="3"/>' +
      '<circle cx="17" cy="17" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="3" stroke-linecap="round" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '" transform="rotate(-90 17 17)"/>' +
      (frac >= 1 ? '<path d="M11 17.5l3.5 3.5 8-8" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' : '') +
      '</svg>';
  }

  function shoppingHTML(wk) {
    var checked = wk.shoppingChecked || {};
    var total = 0, done = 0;
    wk.shopping.forEach(function (g) { g.items.forEach(function (it) { total++; if (checked[it]) done++; }); });
    var h = '<div class="section-title">🛒 Список покупок</div><div class="card shopping">';
    h += '<div class="shop-head">Куплено ' + done + '/' + total + '</div>';
    wk.shopping.forEach(function (g) {
      if (g.category) h += '<div class="shop-cat">' + esc(g.category) + '</div>';
      g.items.forEach(function (it) {
        var on = !!checked[it];
        h += '<label class="shop-item' + (on ? ' on' : '') + '"><input type="checkbox" data-act="shop" data-key="' + esc(it) + '"' + (on ? ' checked' : '') + '><span class="box"></span><span class="txt">' + esc(it) + '</span></label>';
      });
    });
    return h + '</div>';
  }

  /* --- графики --- */
  function chartCardHTML(label, unit, points, target) {
    if (!points.length) return '';
    var first = points[0].value, last = points[points.length - 1].value, delta = last - first;
    var dcls = delta > 0.05 ? 'up' : delta < -0.05 ? 'down' : 'flat';
    var dtxt = (delta > 0 ? '+' : '') + fmtNum(delta) + ' ' + unit;
    var head = '<div class="chart-head"><div class="lbl">' + label + '</div><div><span class="val">' + fmtNum(last) + ' ' + unit + '</span>' +
      (points.length > 1 ? '<span class="delta ' + dcls + '">' + dtxt + '</span>' : '') + '</div></div>';
    return '<div class="card chart-card"><div class="chart">' + head + lineChartSVG(points, target) + '</div></div>';
  }
  function lineChartSVG(points, target) {
    var W = 320, H = 120, pad = 14, padB = 22;
    var vals = points.map(function (p) { return p.value; });
    if (target != null) vals.push(target);
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (min === max) { min -= 1; max += 1; }
    var range = max - min; min -= range * 0.12; max += range * 0.12; range = max - min;
    function X(i) { return points.length === 1 ? W / 2 : pad + (W - 2 * pad) * (i / (points.length - 1)); }
    function Y(v) { return pad + (H - pad - padB) * (1 - (v - min) / range); }
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img">';
    svg += '<defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34e0a1" stop-opacity="0.35"/><stop offset="1" stop-color="#34e0a1" stop-opacity="0"/></linearGradient></defs>';
    if (target != null) {
      var ty = Y(target);
      svg += '<line x1="' + pad + '" y1="' + ty.toFixed(1) + '" x2="' + (W - pad) + '" y2="' + ty.toFixed(1) + '" stroke="#ffb020" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>';
      svg += '<text x="' + (W - pad) + '" y="' + (ty - 4).toFixed(1) + '" fill="#ffb020" font-size="9" text-anchor="end">цель ' + fmtNum(target) + '</text>';
    }
    if (points.length === 1) {
      svg += '<circle cx="' + X(0) + '" cy="' + Y(points[0].value).toFixed(1) + '" r="4" fill="#34e0a1"/>';
    } else {
      var line = '', area = '';
      points.forEach(function (p, i) { var x = X(i).toFixed(1), y = Y(p.value).toFixed(1); line += (i ? 'L' : 'M') + x + ' ' + y + ' '; area += (i ? 'L' : 'M') + x + ' ' + y + ' '; });
      area += 'L' + X(points.length - 1).toFixed(1) + ' ' + (H - padB) + ' L' + X(0).toFixed(1) + ' ' + (H - padB) + ' Z';
      svg += '<path d="' + area + '" fill="url(#ag)"/>';
      svg += '<path d="' + line + '" fill="none" stroke="#34e0a1" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
      svg += '<circle cx="' + X(points.length - 1).toFixed(1) + '" cy="' + Y(points[points.length - 1].value).toFixed(1) + '" r="3.5" fill="#34e0a1"/>';
    }
    svg += '<text x="' + pad + '" y="' + (H - 6) + '" fill="#5f7385" font-size="9">' + fmtDate(points[0].date) + '</text>';
    if (points.length > 1) svg += '<text x="' + (W - pad) + '" y="' + (H - 6) + '" fill="#5f7385" font-size="9" text-anchor="end">' + fmtDate(points[points.length - 1].date) + '</text>';
    return svg + '</svg>';
  }

  /* --- Данные --- */
  function viewData() {
    var wk = currentWeek();
    var h = appbarHTML(null, 'Данные');

    h += '<div class="section-title">Загрузить план от Клода</div><div class="card">' +
      '<div class="btn-row cols"><button class="btn accent" data-act="import-file">📂 Из файла</button>' +
      '<button class="btn" data-act="import-sample">Пример</button></div>' +
      '<div style="margin:12px 0 6px;color:var(--muted);font-size:12px">…или вставь JSON текстом:</div>' +
      '<textarea class="paste" id="pasteArea" placeholder=\'{"schema":"fitness-diary", "week":{...}, "days":[...]}\'></textarea>' +
      '<button class="btn block" style="margin-top:8px" data-act="import-paste">Применить вставленное</button></div>';

    h += '<div class="section-title">Отдать результат Клоду</div><div class="card">';
    if (wk) {
      h += '<div style="color:var(--muted);font-size:13px;margin-bottom:10px">Текущая неделя: <b style="color:var(--text)">' + esc(wk.week.label) + '</b></div>' +
        '<div class="btn-row cols"><button class="btn accent" data-act="export-week">⬇ Скачать неделю</button>' +
        '<button class="btn" data-act="copy-week">Скопировать</button></div>';
    } else { h += '<div style="color:var(--muted);font-size:13px">Сначала загрузи план.</div>'; }
    h += '<button class="btn ghost block small" style="margin-top:8px" data-act="export-all">Резервная копия (все недели)</button></div>';

    h += '<div class="section-title">Связка с Клодом</div><div class="card">' +
      '<div style="font-size:13px;color:var(--muted);margin-bottom:10px">Скопируй инструкцию и вставь в проект «тело» — Клод будет выдавать план сразу в нужном формате.</div>' +
      '<button class="btn block" data-act="copy-prompt">📋 Скопировать инструкцию для Клода</button></div>';

    var ks = weekStarts();
    if (ks.length) {
      h += '<div class="section-title">Сохранённые недели</div><div class="card">';
      ks.slice().reverse().forEach(function (start) {
        var w = state.weeks[start], cur = start === state.currentWeekStart;
        h += '<div class="wk-item' + (cur ? ' cur' : '') + '"><div class="t">' + esc(w.week.label) + '<small>с ' + fmtDate(start) + (cur ? ' · активна' : '') + '</small></div>' +
          (cur ? '' : '<button class="btn small ghost" data-act="switch-week" data-start="' + start + '">Открыть</button>') +
          '<button class="btn small ghost" data-act="del-week" data-start="' + start + '" aria-label="Удалить">🗑</button></div>';
      });
      h += '</div>';
    }

    var s = state.settings;
    h += '<div class="section-title">Настройки</div><div class="card">' +
      '<div class="field-row"><div class="k">«Приготовься», сек<small>отсчёт перед подходом</small></div><input class="num-input" inputmode="numeric" data-setting="prepDefault" value="' + s.prepDefault + '"></div>' +
      '<div class="field-row"><div class="k">Отдых по умолчанию, сек<small>если в плане не задан</small></div><input class="num-input" inputmode="numeric" data-setting="restDefault" value="' + s.restDefault + '"></div>' +
      toggleHTML('autoStartRest', 'Авто-таймер отдыха', 'после ручной отметки ✓', s.autoStartRest) +
      toggleHTML('sound', 'Звук таймера', '', s.sound) +
      toggleHTML('alarmMode', 'Режим будильника', 'громкий сигнал, перебивает музыку, экран блокировки', s.alarmMode) +
      toggleHTML('keepAwake', 'Не гасить экран', 'во время подхода и отдыха', s.keepAwake) +
      toggleHTML('vibrate', 'Вибрация', 'если поддерживается', s.vibrate) + '</div>';

    if (deferredInstall) h += '<div class="card"><button class="btn accent block" data-act="install">⬇ Установить приложение</button></div>';
    h += '<div class="card"><button class="btn danger block" data-act="clear-all">Удалить все данные</button></div>';
    h += '<div style="text-align:center;color:var(--muted-2);font-size:12px;margin:8px 0 0">Тело · дневник · v3 · данные хранятся только на этом устройстве</div>';
    return h;
  }
  function toggleHTML(key, label, hint, on) {
    return '<div class="field-row"><div class="k">' + label + (hint ? '<small>' + hint + '</small>' : '') + '</div>' +
      '<label class="switch"><input type="checkbox" data-setting="' + key + '"' + (on ? ' checked' : '') + '><span class="track"></span><span class="knob"></span></label></div>';
  }

  /* ---------- обработчики ввода ---------- */
  function exById(day, id) { for (var i = 0; i < day.training.exercises.length; i++) if (day.training.exercises[i].id === id) return day.training.exercises[i]; return null; }
  function firstUndone(ex) { for (var i = 0; i < ex.sets.length; i++) if (!ex.sets[i].done) return i; return -1; }

  document.addEventListener('input', function (e) {
    var t = e.target, act = t.getAttribute && t.getAttribute('data-act');
    if (act === 'setf') {
      var wk = currentWeek(); if (!wk) return;
      var ex = exById(wk.days[+t.getAttribute('data-d')], t.getAttribute('data-ex')); if (!ex) return;
      ex.sets[+t.getAttribute('data-s')][t.getAttribute('data-f')] = numOrNull(t.value); saveSoon();
    } else if (act === 'bodyf') {
      var wk2 = currentWeek(); if (!wk2) return;
      wk2.days[+t.getAttribute('data-d')].body[t.getAttribute('data-f')] = numOrNull(t.value); saveSoon();
    } else if (act === 'notef') {
      var wk3 = currentWeek(); if (!wk3) return;
      wk3.days[+t.getAttribute('data-d')].userNote = t.value; saveSoon();
    }
  });

  document.addEventListener('change', function (e) {
    var t = e.target, act = t.getAttribute && t.getAttribute('data-act'), setKey = t.getAttribute && t.getAttribute('data-setting');
    if (setKey) {
      if (t.type === 'checkbox') state.settings[setKey] = t.checked;
      else if (setKey === 'prepDefault') state.settings.prepDefault = Math.max(0, Math.min(20, numOrNull(t.value) || 0));
      else state.settings[setKey] = Math.max(5, numOrNull(t.value) || state.settings.restDefault);
      save();
    }
    if (act === 'shop') {
      var wk = currentWeek(); if (wk) { wk.shoppingChecked[t.getAttribute('data-key')] = t.checked; save(); render(true); }
    }
    if (t.id === 'fileInput' && t.files && t.files[0]) {
      var f = t.files[0], r = new FileReader();
      r.onload = function () { try { importData(JSON.parse(r.result)); } catch (err) { toast('Не удалось прочитать: ' + err.message, 'bad'); } t.value = ''; };
      r.readAsText(f);
    }
  });
  document.addEventListener('toggle', function (e) {
    if (e.target && e.target.matches && e.target.matches('details.nutri')) ui.nutriOpen = e.target.open;
  }, true);

  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    var act = btn.getAttribute('data-act'), wk = currentWeek();
    function day() { return wk.days[+btn.getAttribute('data-d')]; }
    function exHere() { return exById(day(), btn.getAttribute('data-ex')); }

    switch (act) {
      case 'tab': ui.tab = btn.getAttribute('data-tab'); render(); break;
      case 'selday':
        ui.selectedDate = btn.getAttribute('data-date');
        if (btn.getAttribute('data-go') === 'today') ui.tab = 'today';
        render(); break;

      case 'start-set': if (wk) Bar.startGuided(+btn.getAttribute('data-d'), exHere(), +btn.getAttribute('data-s')); break;
      case 'start-next': {
        if (!wk) break;
        var exN = exHere(), idx = firstUndone(exN);
        if (idx < 0) { toast('Все подходы отмечены ✓', 'good'); break; }
        Bar.startGuided(+btn.getAttribute('data-d'), exN, idx); break;
      }
      case 'guide-work': Bar.toWork(); break;
      case 'guide-done': Bar.finishWork(); break;
      case 'guide-cancel': Bar.hide(); break;
      case 'timer-add': Bar.addRest(15); break;
      case 'timer-skip': Bar.hide(); break;
      case 'rest': Bar.startRest(+btn.getAttribute('data-sec') || state.settings.restDefault, 'Отдых · ' + (btn.getAttribute('data-name') || '')); break;

      case 'done': {
        if (!wk) break;
        var ex = exHere(), si = +btn.getAttribute('data-s'), st = ex.sets[si];
        st.done = !st.done;
        if (st.done) {
          if (st.reps == null && ex.targetReps && /^\d+$/.test(ex.targetReps)) st.reps = +ex.targetReps;
          if (st.weight == null && ex.targetWeight != null) st.weight = ex.targetWeight;
          if (state.settings.autoStartRest) {
            var isLast = si === ex.sets.length - 1;
            var sec = isLast ? (ex.restAfter || ex.rest || state.settings.restDefault) : (ex.rest || state.settings.restDefault);
            Bar.startRest(sec, (isLast ? 'Отдых перед след. упражнением' : 'Отдых') + (ex.name ? ' · ' + ex.name : ''));
          }
        }
        save(); render(true); break;
      }
      case 'addset': {
        if (!wk) break;
        var ex2 = exHere(), prev = ex2.sets[ex2.sets.length - 1];
        ex2.sets.push(prev ? { reps: prev.reps, weight: prev.weight, rpe: prev.rpe, tut: null, done: false } : { reps: null, weight: null, rpe: null, tut: null, done: false });
        save(); render(true); break;
      }
      case 'delset': if (wk) { exHere().sets.splice(+btn.getAttribute('data-s'), 1); save(); render(true); } break;

      case 'import-file': $('#fileInput').click(); break;
      case 'import-sample':
        fetch('sample-week.json').then(function (r) { return r.json(); }).then(function (j) { importData(j); }).catch(function () { toast('Пример недоступен офлайн', 'bad'); });
        break;
      case 'import-paste': {
        var ta = $('#pasteArea');
        if (!ta || !ta.value.trim()) { toast('Вставь JSON в поле', 'bad'); break; }
        try { importData(JSON.parse(ta.value)); } catch (err) { toast('Ошибка JSON: ' + err.message, 'bad'); }
        break;
      }
      case 'export-week': if (wk) download('telo-' + wk.week.startDate + '.json', JSON.stringify(buildExport(wk), null, 2)); break;
      case 'copy-week': if (wk) copyText(JSON.stringify(buildExport(wk), null, 2)).then(function () { toast('Скопировано в буфер', 'good'); }, function () { toast('Не вышло скопировать', 'bad'); }); break;
      case 'export-all': download('telo-backup-' + todayISO() + '.json', JSON.stringify({ schema: SCHEMA, version: VERSION, exportedAt: new Date().toISOString(), weeks: state.weeks, seededTrends: state.seededTrends }, null, 2)); break;
      case 'copy-prompt': copyText(CLAUDE_PROMPT).then(function () { toast('Инструкция скопирована', 'good'); }, function () { toast('Не вышло скопировать', 'bad'); }); break;

      case 'switch-week': state.currentWeekStart = btn.getAttribute('data-start'); ui.selectedDate = null; save(); ui.tab = 'today'; render(); break;
      case 'del-week': {
        var ds = btn.getAttribute('data-start');
        if (!confirm('Удалить неделю «' + (state.weeks[ds] ? state.weeks[ds].week.label : ds) + '»?')) break;
        delete state.weeks[ds];
        if (state.currentWeekStart === ds) { var ks = weekStarts(); state.currentWeekStart = ks[ks.length - 1] || null; ui.selectedDate = null; }
        save(); render(); break;
      }
      case 'install': if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; } break;
      case 'clear-all':
        if (confirm('Удалить ВСЕ данные дневника без возможности восстановления?')) { state = defaultState(); ui.selectedDate = null; save(); ui.tab = 'data'; render(); toast('Данные удалены', 'good'); }
        break;
    }
  });

  /* ---------- тихий WAV для удержания аудио-сессии (экран блокировки iOS) ---------- */
  function silentWavUrl(seconds) {
    var sr = 8000, n = sr * seconds, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf), p = 0;
    function s(str) { for (var i = 0; i < str.length; i++) v.setUint8(p++, str.charCodeAt(i)); }
    function u32(x) { v.setUint32(p, x, true); p += 4; }
    function u16(x) { v.setUint16(p, x, true); p += 2; }
    s('RIFF'); u32(36 + n * 2); s('WAVE'); s('fmt '); u32(16); u16(1); u16(1); u32(sr); u32(sr * 2); u16(2); u16(16); s('data'); u32(n * 2);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  /* ---------- звук: громкий «будильник», заранее запланированный (работает и в фоне) ---------- */
  var Audio2 = {
    ctx: null, scheduled: [], keepEl: null, keepUrl: null,
    on: function () { return state.settings.sound; },
    ensure: function () {
      if (!this.on()) return;
      try {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) {}
      if (state.settings.alarmMode && navigator.audioSession) { try { navigator.audioSession.type = 'playback'; } catch (e) {} }
    },
    keepAliveStart: function () {
      if (!state.settings.alarmMode || !this.on()) return;
      try {
        if (!this.keepUrl) this.keepUrl = silentWavUrl(1);
        if (!this.keepEl) { this.keepEl = new Audio(this.keepUrl); this.keepEl.loop = true; this.keepEl.volume = 0.02; }
        var pr = this.keepEl.play(); if (pr && pr.catch) pr.catch(function () {});
      } catch (e) {}
    },
    keepAliveStop: function () { try { if (this.keepEl) this.keepEl.pause(); } catch (e) {} },
    release: function () { this.keepAliveStop(); if (navigator.audioSession) { try { navigator.audioSession.type = 'auto'; } catch (e) {} } },
    tone: function (when, freq, dur, vol, type) {
      if (!this.on() || !this.ctx) return;
      try {
        var o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = type || 'square'; o.frequency.value = freq;
        o.connect(g); g.connect(this.ctx.destination);
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(vol, when + 0.012);
        g.gain.setValueAtTime(vol, when + dur - 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
        o.start(when); o.stop(when + dur + 0.03);
        this.scheduled.push(o);
      } catch (e) {}
    },
    alarmAt: function (offsetSec, kind) {
      if (!this.on() || !this.ctx) return;
      var t0 = this.ctx.currentTime + Math.max(0, offsetSec);
      if (kind === 'stop') {
        for (var i = 0; i < 4; i++) { var b = t0 + i * 0.42; this.tone(b, 988, 0.15, 0.85, 'square'); this.tone(b + 0.19, 1319, 0.17, 0.85, 'square'); }
      } else {
        this.tone(t0, 1175, 0.16, 0.85, 'square'); this.tone(t0 + 0.22, 1568, 0.22, 0.85, 'square');
      }
    },
    tickAt: function (offsetSec) { if (this.on() && this.ctx) this.tone(this.ctx.currentTime + Math.max(0, offsetSec), 740, 0.07, 0.4, 'square'); },
    cancel: function () { this.scheduled.forEach(function (o) { try { o.stop(); o.disconnect(); } catch (e) {} }); this.scheduled = []; },
    buzz: function () { if (state.settings.vibrate && navigator.vibrate) { try { navigator.vibrate([200, 90, 200, 90, 350]); } catch (e) {} } }
  };

  /* ---------- не гасить экран во время таймера ---------- */
  var Wake = {
    lock: null,
    request: function () {
      if (!state.settings.keepAwake || !('wakeLock' in navigator)) return;
      try {
        navigator.wakeLock.request('screen').then(function (l) {
          Wake.lock = l;
          if (l.addEventListener) l.addEventListener('release', function () { Wake.lock = null; });
        }).catch(function () {});
      } catch (e) {}
    },
    release: function () { try { if (this.lock) { this.lock.release(); this.lock = null; } } catch (e) {} }
  };

  /* ---------- плитка таймера на экране блокировки ---------- */
  var Media = {
    setup: function () {
      if (!('mediaSession' in navigator)) return;
      try {
        navigator.mediaSession.setActionHandler('pause', function () { Bar.hide(); });
        navigator.mediaSession.setActionHandler('stop', function () { Bar.hide(); });
        navigator.mediaSession.setActionHandler('play', function () {});
        navigator.mediaSession.setActionHandler('nexttrack', function () { if (Bar.phase === 'rest') Bar.hide(); });
      } catch (e) {}
    },
    meta: function (title, sub) {
      if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: title, artist: sub || 'Тело', album: 'Тренировка' }); navigator.mediaSession.playbackState = 'playing'; } catch (e) {}
    },
    pos: function (dur, posn) {
      if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
      try { var d = Math.max(1, dur); navigator.mediaSession.setPositionState({ duration: d, position: Math.min(Math.max(0, posn), d), playbackRate: 1 }); } catch (e) {}
    },
    clear: function () { if (!('mediaSession' in navigator)) return; try { navigator.mediaSession.playbackState = 'none'; navigator.mediaSession.metadata = null; } catch (e) {} }
  };

  /* ---------- нижняя панель: управляемый подход + отдых (на метках времени) ---------- */
  var Bar = {
    el: $('#timerbar'), iv: null, phase: null,
    d: null, exId: null, s: null, exName: '', isLast: false,
    endAt: 0, startAt: 0, total: 0, target: 0, restLabel: '', hideT: null,

    now: function () { return Date.now(); },
    loop: function () { var self = this; clearInterval(this.iv); this.iv = setInterval(function () { self.tick(); }, 250); },
    ctxEx: function () { var wk = currentWeek(); if (!wk) return null; var dd = wk.days[this.d]; return dd ? exById(dd, this.exId) : null; },
    begin: function () { Audio2.ensure(); Audio2.cancel(); Audio2.keepAliveStart(); Media.setup(); Wake.request(); },
    schedTicks: function (endSec) { for (var k = 3; k >= 1; k--) if (endSec - k > 0.2) Audio2.tickAt(endSec - k); },
    leftSec: function () { return Math.max(0, Math.ceil((this.endAt - this.now()) / 1000)); },
    workSec: function () { return Math.max(0, Math.floor((this.now() - this.startAt) / 1000)); },

    startGuided: function (dIdx, ex, sIdx) {
      if (!ex) return;
      this.d = dIdx; this.exId = ex.id; this.s = sIdx; this.exName = ex.name;
      this.isLast = sIdx === ex.sets.length - 1;
      this.target = ex.tut || 0;
      this.begin();
      var prep = ex.prep != null ? ex.prep : state.settings.prepDefault;
      if (prep > 0) {
        this.phase = 'prep'; this.total = prep; this.endAt = this.now() + prep * 1000;
        Audio2.alarmAt(prep, 'go'); this.schedTicks(prep);
        this.draw(); this.loop();
      } else this.toWork(false);
    },
    toWork: function (fromPrep) {
      this.phase = 'work'; this.startAt = this.now();
      if (!fromPrep) { Audio2.cancel(); Audio2.alarmAt(0, 'go'); }
      Audio2.keepAliveStart();
      if (this.target) { Audio2.alarmAt(this.target, 'stop'); this.schedTicks(this.target); }
      this.draw(); this.loop();
    },
    finishWork: function () {
      var ex = this.ctxEx();
      Audio2.cancel();
      if (!ex) { this.hide(); return; }
      var st = ex.sets[this.s];
      if (st) {
        var el = Math.round((this.now() - this.startAt) / 1000);
        st.tut = el || null;
        if (!st.done) {
          st.done = true;
          if (st.reps == null && ex.targetReps && /^\d+$/.test(ex.targetReps)) st.reps = +ex.targetReps;
          if (st.weight == null && ex.targetWeight != null) st.weight = ex.targetWeight;
        }
      }
      var sec = this.isLast ? (ex.restAfter || ex.rest || state.settings.restDefault) : (ex.rest || state.settings.restDefault);
      save(); render(true);
      this.toRest(sec, (this.isLast ? 'Отдых перед след. упражнением' : 'Отдых') + (this.exName ? ' · ' + this.exName : ''));
    },
    toRest: function (sec, label) {
      this.phase = 'rest'; this.total = Math.max(1, Math.round(sec)); this.endAt = this.now() + this.total * 1000; this.restLabel = label;
      Audio2.cancel(); Audio2.keepAliveStart();
      Audio2.alarmAt(this.total, 'go'); this.schedTicks(this.total);
      this.draw(); this.loop();
    },
    startRest: function (sec, label) { this.d = null; this.exId = null; this.exName = ''; this.begin(); this.toRest(Math.max(5, Math.round(sec || state.settings.restDefault)), label || 'Отдых'); },

    tick: function () {
      if (this.phase === 'prep') { if (this.leftSec() <= 0) { this.toWork(true); return; } this.draw(); }
      else if (this.phase === 'work') { this.draw(); }
      else if (this.phase === 'rest') { if (this.leftSec() <= 0) { this.restDone(); return; } this.draw(); }
    },
    restDone: function () { clearInterval(this.iv); this.iv = null; this.phase = 'done'; Audio2.buzz(); this.draw(); var self = this; clearTimeout(this.hideT); this.hideT = setTimeout(function () { self.hide(); }, 6000); },
    addRest: function (s) {
      if (this.phase !== 'rest') return;
      this.endAt += s * 1000; this.total += s;
      Audio2.cancel(); var left = (this.endAt - this.now()) / 1000; Audio2.alarmAt(left, 'go'); this.schedTicks(left); this.draw();
    },
    hide: function () { clearInterval(this.iv); this.iv = null; clearTimeout(this.hideT); this.phase = null; Audio2.cancel(); Audio2.release(); Wake.release(); Media.clear(); this.el.hidden = true; this.el.className = ''; },
    resync: function () {
      if (!this.phase) return;
      if (this.phase === 'prep' && this.leftSec() <= 0) { this.toWork(true); return; }
      if (this.phase === 'rest' && this.leftSec() <= 0) { this.restDone(); return; }
      if (this.phase !== 'done') { Wake.request(); this.loop(); }
      this.draw();
    },

    fmt: function (s) { s = Math.max(0, Math.round(s)); var m = Math.floor(s / 60); return m + ':' + pad(s % 60); },
    draw: function () {
      var p = this.phase; if (!p) { this.el.hidden = true; return; }
      this.el.hidden = false; this.el.className = p;
      var inner = '';
      if (p === 'prep') {
        var lp = this.leftSec(); var tt = 'Приготовься' + (this.exName ? ' · ' + this.exName : '');
        inner = '<div class="timer-time">' + lp + '</div><div class="timer-mid"><div class="timer-lbl">' + esc(tt) + '</div><div class="timer-sub">подход ' + (this.s + 1) + '</div></div>' +
          '<button class="btn small" data-act="guide-work">Старт</button><button class="btn small" data-act="guide-cancel">✕</button>';
        Media.meta(tt, this.fmt(lp)); Media.pos(this.total, this.total - lp);
      } else if (p === 'work') {
        var el = this.workSec(); var reached = this.target && el >= this.target; var frac = this.target ? Math.min(1, el / this.target) : 0;
        var tw = 'Под нагрузкой' + (this.exName ? ' · ' + this.exName : '');
        inner = '<div class="timer-time">' + this.fmt(el) + '</div><div class="timer-mid"><div class="timer-lbl">' + esc(tw) + '</div>' +
          (this.target ? '<div class="timer-bar"><i style="width:' + (frac * 100).toFixed(0) + '%"></i></div>' + (reached ? '<div class="timer-sub">цель достигнута — заканчивай</div>' : '<div class="timer-sub">цель ' + this.target + 'с</div>') : '<div class="timer-sub">секундомер</div>') +
          '</div><button class="btn small go" data-act="guide-done">Готово ✓</button><button class="btn small" data-act="guide-cancel">✕</button>';
        Media.meta(tw, this.fmt(el)); Media.pos(this.target || (el + 1), el);
      } else if (p === 'rest') {
        var lr = this.leftSec(); var frac2 = this.total ? lr / this.total : 0;
        inner = '<div class="timer-time">' + this.fmt(lr) + '</div><div class="timer-mid"><div class="timer-lbl">' + esc(this.restLabel || 'Отдых') + '</div><div class="timer-bar"><i style="width:' + (frac2 * 100).toFixed(1) + '%"></i></div></div>' +
          '<button class="btn small" data-act="timer-add">+15с</button><button class="btn small" data-act="timer-skip">Стоп</button>';
        Media.meta(this.restLabel || 'Отдых', this.fmt(lr)); Media.pos(this.total, this.total - lr);
      } else {
        inner = '<div class="timer-time">Го!</div><div class="timer-mid"><div class="timer-lbl">Отдых окончен' + (this.exName ? ' · ' + esc(this.exName) : '') + '</div></div><button class="btn small" data-act="timer-skip">Ок</button>';
      }
      this.el.innerHTML = '<div class="timer-inner">' + inner + '</div>';
    }
  };

  // пересчёт при возврате (разблокировали экран / вкладка снова активна)
  document.addEventListener('visibilitychange', function () { if (!document.hidden) Bar.resync(); });
  window.addEventListener('focus', function () { Bar.resync(); });

  /* ---------- toast ---------- */
  var toastT = null;
  function toast(msg, type) {
    var el = $('#toast'); el.textContent = msg; el.className = type || ''; el.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(function () { el.hidden = true; }, 2600);
  }

  /* ---------- установка PWA ---------- */
  var deferredInstall = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredInstall = e; if (ui.tab === 'data') render(); });

  /* ---------- инструкция для Клода ---------- */
  var CLAUDE_PROMPT = [
    'Когда я прошу план на неделю (тренировки + питание), выдавай его ОДНИМ блоком кода JSON строго в таком формате — я загружаю его в приложение-дневник «Тело»:',
    '',
    '```json',
    '{',
    '  "schema": "fitness-diary",',
    '  "version": 1,',
    '  "week": { "label": "Неделя 1", "startDate": "ГГГГ-ММ-ДД (понедельник)", "goal": "коротко цель недели" },',
    '  "athlete": { "targets": { "weightKg": 90, "waistCm": 85 } },',
    '  "days": [',
    '    {',
    '      "date": "ГГГГ-ММ-ДД",',
    '      "training": {',
    '        "title": "Грудь + трицепс",',
    '        "isRestDay": false,',
    '        "notes": "разминка 10 мин",',
    '        "exercises": [',
    '          { "name": "Жим лёжа", "targetSets": 4, "targetReps": "8-10", "targetWeight": 60, "targetRpe": 8,',
    '            "tut": 40, "rest": 120, "restAfter": 180, "notes": "" }',
    '        ]',
    '      },',
    '      "nutrition": {',
    '        "title": "2200 ккал",',
    '        "summary": { "kcal": 2200, "protein": 180, "carbs": 200, "fat": 60 },',
    '        "meals": [ { "name": "Завтрак", "items": ["Овсянка 80г", "Яйца 3шт"], "kcal": 550 } ]',
    '      }',
    '    }',
    '  ],',
    '  "shopping": [',
    '    { "category": "Белок", "items": ["Куриная грудка 1.5 кг", "Яйца 30 шт"] },',
    '    { "category": "Крупы", "items": ["Овсянка 1 кг", "Рис 1 кг"] }',
    '  ]',
    '}',
    '```',
    '',
    'Правила:',
    '- 7 объектов в "days", даты подряд от startDate. День отдыха: "isRestDay": true и пустой "exercises".',
    '- По таймингам у каждого упражнения: "tut" — время под нагрузкой (сек/подход), "rest" — отдых между подходами (сек), "restAfter" — отдых между упражнениями (сек).',
    '- "targetReps" — строка ("8-10" или "12"). Вес/RPE/tut/rest — числа или null.',
    '- "shopping" — список покупок на неделю (сгруппируй по категориям), посчитай количества из плана питания.',
    '- Поля факта ("sets", "body", "userNote") НЕ заполняй — это сделаю я в приложении. "userNote" — мои свободные заметки за день (как прошла тренировка, что по питанию, сколько ел).',
    '- Питание — только для просмотра (без отметок).',
    '- Когда пришлю экспорт за неделю (тот же JSON с фактом, моими заметками "userNote" по дням и блоком "trends" — динамика веса/талии) — учти заметки, проанализируй факт vs план и выдай следующую неделю в этом же формате.'
  ].join('\n');

  /* ---------- старт ---------- */
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
  render();
})();
