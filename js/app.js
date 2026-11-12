'use strict';
/* ================= 基本 ================= */
var $ = function(s, r){ return (r || document).querySelector(s); };
var $$ = function(s, r){ return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
var DAY = 86400000;
var RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
var SR_DAYS = [1, 2, 4, 8, 16, 32];          // 間隔反復: 正解を重ねるごとに出し直す間隔(日)
var GAP = 0.08;                               // アプリ内テストは台本から出るので、本番は8ポイント低く見積もる
var N_EXAM = 145;                             // 本番の問題数(オンライン試験、145問程度)
var MODEL_SD = 0.04;                          // 推定そのもののぶれ
var DEFAULT_DUR = 20 * 60;                    // 音声未登録のときの仮の長さ(秒)
var SID = S.map(function(s){ return s.id; });
var SC = {}; S.forEach(function(s){ SC[s.id] = s; });

function esc(x){ return String(x == null ? '' : x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); }
function pct(x){ return Math.round(x * 100); }
function fmtT(sec){ sec = Math.max(0, Math.floor(sec || 0)); var h = Math.floor(sec/3600), m = Math.floor(sec%3600/60), s = sec%60; return (h ? h + ':' + String(m).padStart(2,'0') : m) + ':' + String(s).padStart(2,'0'); }
function fmtMin(sec){ var m = Math.round(sec/60); return m >= 60 ? Math.floor(m/60) + '時間' + (m%60 ? (m%60) + '分' : '') : m + '分'; }
function dkey(d){ d = d || new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
function shuffle(a){ a = a.slice(); for (var i = a.length - 1; i > 0; i--){ var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function sc(id){ return SC[id]; }
function scStyle(id){ var s = sc(id); return '--ac:' + s.ac + ';--tint:' + s.tint; }

var toastT = null;
function toast(msg){ var t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(function(){ t.classList.remove('on'); }, 2600); }

/* ================= 保存データ ================= */
var KEY = 'gken-app';
function defaults(){
  return { v:1, settings:{ examDate:'2027-01-16', targetListens:3, passLine:70, viewMode:'auto', rate:1, autoNext:false,
    weights:{ s1:18, s2:18, s3:14, s4:18, s5:12, s6:8, s7:12 } },
    audio:{}, cal:{}, quiz:{}, log:{}, done:{}, est:{}, last:null };
}
function normalize(o){
  var d = defaults();
  if (!o || typeof o !== 'object') return d;
  o.settings = Object.assign(d.settings, o.settings || {});
  o.settings.weights = Object.assign(defaults().settings.weights, (o.settings && o.settings.weights) || {});
  ['audio','cal','quiz','log','done','est'].forEach(function(k){ if (!o[k] || typeof o[k] !== 'object') o[k] = {}; });
  o.v = 1; return o;
}
var st;
try { st = normalize(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch (e) { st = defaults(); }
var saveT = null;
function save(now){
  clearTimeout(saveT);
  var f = function(){ try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { toast('保存できませんでした。端末の空き容量を確認してください'); } };
  if (now) f(); else saveT = setTimeout(f, 500);
}
window.addEventListener('pagehide', function(){ save(true); });
document.addEventListener('visibilitychange', function(){ if (document.hidden) save(true); });

function A(id){ if (!st.audio[id]) st.audio[id] = { name:'', dur:0, pos:0, count:0, heard:'', lastAt:0 }; return st.audio[id]; }
function logAdd(field, n){ var k = dkey(); var l = st.log[k] || (st.log[k] = { listen:0, q:0, c:0 }); l[field] = (l[field] || 0) + n; }

/* ================= IndexedDB(音声ファイル) ================= */
var idb = {
  db:null,
  open:function(){ var self = this; if (self.db) return Promise.resolve(self.db);
    return new Promise(function(res, rej){ var r = indexedDB.open('gken', 1);
      r.onupgradeneeded = function(){ r.result.createObjectStore('audio'); };
      r.onsuccess = function(){ self.db = r.result; res(self.db); };
      r.onerror = function(){ rej(r.error); }; }); },
  req:function(mode, fn){ return this.open().then(function(db){ return new Promise(function(res, rej){
      var tx = db.transaction('audio', mode); var store = tx.objectStore('audio'); var r = fn(store); var out;
      if (r) r.onsuccess = function(){ out = r.result; };
      tx.oncomplete = function(){ res(out); }; tx.onerror = function(){ rej(tx.error); }; tx.onabort = function(){ rej(tx.error); }; }); }); },
  get:function(k){ return this.req('readonly', function(s){ return s.get(k); }); },
  put:function(k, v){ return this.req('readwrite', function(s){ return s.put(v, k); }); },
  del:function(k){ return this.req('readwrite', function(s){ return s.delete(k); }); },
  keys:function(){ return this.req('readonly', function(s){ return s.getAllKeys(); }); }
};
var hasFile = {};
function refreshFiles(){ return idb.keys().then(function(ks){ hasFile = {}; (ks || []).forEach(function(k){ hasFile[k] = true; }); }).catch(function(){ hasFile = {}; }); }

/* ================= 聞いた範囲(10秒ごとの区切り) ================= */
var SEG = 10;
function nseg(a){ return Math.max(1, Math.ceil((a.dur || DEFAULT_DUR) / SEG)); }
function heardArr(a){ var n = nseg(a), h = a.heard || '', out = []; for (var i = 0; i < n; i++) out.push(h.charAt(i) === '1'); return out; }
function coverage(a){ if (!a.dur) return 0; var h = heardArr(a), c = 0; h.forEach(function(x){ if (x) c++; }); return c / h.length; }
function markHeard(id, t0, t1){
  var a = A(id); if (!a.dur) return;
  var h = heardArr(a), i0 = Math.floor(t0 / SEG), i1 = Math.floor(t1 / SEG);
  for (var i = i0; i <= i1 && i < h.length; i++) h[i] = true;
  a.heard = h.map(function(x){ return x ? '1' : '0'; }).join('');
  if (coverage(a) >= 0.9){ a.count++; a.heard = ''; toast(sc(id).no + ' ' + sc(id).title + ' を' + a.count + '回聞き終えました'); save(true); renderAll(); }
}
function heardBar(id, withTicks){
  var a = A(id), h = heardArr(a), n = h.length, html = '';
  var step = Math.max(1, Math.ceil(n / 120)); /* 長い音声は描画をまとめる */
  for (var i = 0; i < n; i += step){ var any = false; for (var j = i; j < i + step && j < n; j++) if (h[j]) any = true; html += '<span' + (any ? ' class="h"' : '') + '></span>'; }
  if (withTicks){ chStarts(id).forEach(function(t, k){ if (k > 0) html += '<i class="tick" style="left:' + (t / (a.dur || DEFAULT_DUR) * 100) + '%"></i>'; }); }
  var p = a.dur ? clamp(a.pos / a.dur, 0, 1) : 0;
  html += '<i class="pos" style="left:calc(' + (p * 100) + '% - 1px)"></i>';
  return html;
}

/* ================= パート区切り ================= */
function chStarts(id){
  var a = A(id), d = a.dur || DEFAULT_DUR, c = CH[id], cal = st.cal[id] || {};
  return c.list.map(function(x, i){ return cal[i] != null ? cal[i] : (i === 0 ? 0 : x[1] / c.end * d); });
}
function chRange(id, i){ var s = chStarts(id), a = A(id); return [s[i], i + 1 < s.length ? s[i + 1] : (a.dur || DEFAULT_DUR)]; }
function chAt(id, t){ var s = chStarts(id), k = 0; for (var i = 0; i < s.length; i++) if (t >= s[i] - 0.25) k = i; return k; }
function chHeard(id, i){ var a = A(id); if (!a.dur) return 0; var r = chRange(id, i), h = heardArr(a), i0 = Math.floor(r[0] / SEG), i1 = Math.max(i0, Math.ceil(r[1] / SEG) - 1), c = 0, n = 0; for (var k = i0; k <= i1 && k < h.length; k++){ n++; if (h[k]) c++; } return n ? c / n : 0; }

/* ================= プレーヤー ================= */
var au = $('#au'), cur = st.last || null, objUrl = null, lastT = 0, loopCh = null, lastSave = 0;
var sleep = { mode:null, end:0, iv:null };

function loadScenario(id, opt){
  opt = opt || {};
  cur = id; st.last = id; save(); loopCh = null;
  return idb.get(id).catch(function(){ return null; }).then(function(rec){
    if (objUrl){ URL.revokeObjectURL(objUrl); objUrl = null; }
    if (!rec || !rec.blob){ au.removeAttribute('src'); try { au.load(); } catch (e) {} renderPlayer(); renderMini(); return false; }
    objUrl = URL.createObjectURL(rec.blob); au.src = objUrl;
    return new Promise(function(res){
      var done = function(){ res(true); };
      au.addEventListener('loadedmetadata', done, { once:true }); au.addEventListener('error', function(){ res(false); }, { once:true });
    }).then(function(ok){
      if (!ok){ toast('音声を読み込めませんでした。ファイルを選び直してください'); renderPlayer(); return false; }
      var a = A(id);
      if (isFinite(au.duration) && au.duration > 0){ if (a.dur && Math.abs(a.dur - au.duration) > 2) a.heard = ''; a.dur = au.duration; }
      au.playbackRate = st.settings.rate; au.defaultPlaybackRate = st.settings.rate;
      var t = opt.seek != null ? opt.seek : (a.pos || 0);
      if (t > 0 && t < a.dur - 1) au.currentTime = t; else if (t >= a.dur - 1) au.currentTime = 0;
      lastT = au.currentTime; setMeta(); save(); renderPlayer(); renderMini();
      if (opt.play) au.play().catch(function(){});
      return true;
    });
  });
}
function togglePlay(){
  if (!cur || !au.src){ go('listen'); return; }
  if (au.paused) au.play().catch(function(){ toast('再生できませんでした'); }); else au.pause();
}
function seekBy(d){ if (!au.src) return; au.currentTime = clamp(au.currentTime + d, 0, au.duration || 0); lastT = au.currentTime; updateProgress(); }
function seekTo(t){ if (!au.src) return; au.currentTime = clamp(t, 0, au.duration || 0); lastT = au.currentTime; updateProgress(); }
function gotoCh(i, play){ var s = chStarts(cur); if (i < 0 || i >= s.length) return; seekTo(s[i] + 0.05); if (play) au.play().catch(function(){}); }
function prevCh(){ var t = au.currentTime, k = chAt(cur, t), s = chStarts(cur); gotoCh(t - s[k] > 3 ? k : k - 1); }
function nextCh(){ gotoCh(chAt(cur, au.currentTime) + 1); }
function setRate(r){ st.settings.rate = r; au.playbackRate = r; au.defaultPlaybackRate = r; save(); renderPlayer(); }

au.addEventListener('timeupdate', function(){
  if (!cur) return;
  var t = au.currentTime, a = A(cur), d = t - lastT;
  if (!au.paused && d > 0 && d < 3 * Math.max(1, st.settings.rate)){ markHeard(cur, lastT, t); logAdd('listen', d); a.lastAt = Date.now(); }
  lastT = t; a.pos = t;
  if (loopCh != null){ var r = chRange(cur, loopCh); if (t >= r[1] - 0.3){ au.currentTime = r[0]; lastT = r[0]; } }
  if (sleep.mode === 'ch' && t >= sleep.chEnd - 0.2) fireSleep();
  if (Date.now() - lastSave > 5000){ lastSave = Date.now(); save(); }
  updateProgress();
});
au.addEventListener('play', function(){ lastT = au.currentTime; renderPlayState(); setPosState(); });
au.addEventListener('pause', function(){ A(cur).pos = au.currentTime; save(true); renderPlayState(); });
au.addEventListener('ratechange', setPosState);
au.addEventListener('ended', function(){
  var a = A(cur); a.pos = 0; save(true); renderPlayState();
  if (sleep.mode === 'file'){ fireSleep(); return; }
  if (st.settings.autoNext){
    var i = SID.indexOf(cur);
    for (var k = i + 1; k < SID.length; k++) if (hasFile[SID[k]]){ loadScenario(SID[k], { play:true, seek:0 }); return; }
  }
});

/* ロック画面・通知の操作 */
function setMeta(){
  if (!('mediaSession' in navigator) || !cur) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: sc(cur).no + ' ' + sc(cur).title, artist:'G検定 耳学習', album: CH[cur].list[chAt(cur, au.currentTime)][0],
      artwork:[{ src:'icons/icon-192.png', sizes:'192x192', type:'image/png' }, { src:'icons/icon-512.png', sizes:'512x512', type:'image/png' }] });
  } catch (e) {}
}
var lastChShown = -1;
function setPosState(){ if (!('mediaSession' in navigator) || !au.duration || !isFinite(au.duration)) return; try { navigator.mediaSession.setPositionState({ duration:au.duration, playbackRate:au.playbackRate, position:clamp(au.currentTime, 0, au.duration) }); } catch (e) {} }
if ('mediaSession' in navigator){
  var ms = navigator.mediaSession, h = function(n, f){ try { ms.setActionHandler(n, f); } catch (e) {} };
  h('play', function(){ au.play(); }); h('pause', function(){ au.pause(); });
  h('seekbackward', function(e){ seekBy(-((e && e.seekOffset) || 5)); });
  h('seekforward', function(e){ seekBy((e && e.seekOffset) || 5); });
  h('previoustrack', prevCh); h('nexttrack', nextCh);
  h('seekto', function(e){ if (e && e.seekTime != null) seekTo(e.seekTime); });
}

/* スリープタイマー */
function setSleep(v){
  clearInterval(sleep.iv); sleep = { mode:null, end:0, iv:null, chEnd:0 };
  if (v === 'off'){ renderSleep(); return; }
  if (v === 'ch'){ sleep.mode = 'ch'; sleep.chEnd = chRange(cur, chAt(cur, au.currentTime))[1]; }
  else if (v === 'file'){ sleep.mode = 'file'; }
  else { sleep.mode = 'min'; sleep.end = Date.now() + Number(v) * 60000; sleep.iv = setInterval(function(){ if (Date.now() >= sleep.end) fireSleep(); renderSleep(); }, 1000); }
  renderSleep(); toast('スリープタイマーを設定しました');
}
function fireSleep(){
  clearInterval(sleep.iv); sleep = { mode:null, end:0, iv:null };
  var v0 = au.volume, steps = 10, n = 0;
  var f = setInterval(function(){ n++; au.volume = Math.max(0, v0 * (1 - n / steps)); if (n >= steps){ clearInterval(f); au.pause(); au.volume = v0; } }, 300);
  renderSleep(); toast('スリープタイマーで停止しました');
}
function sleepLabel(){
  if (!sleep.mode) return 'オフ';
  if (sleep.mode === 'ch') return 'このパートの終わりで停止';
  if (sleep.mode === 'file') return 'この音声の終わりで停止';
  return 'あと ' + fmtT((sleep.end - Date.now()) / 1000) + ' で停止';
}

/* ================= 小テスト(間隔反復) ================= */
function R(id){ return st.quiz[id] || null; }
function isDue(q){ var r = R(q.id); return !!r && r.due <= Date.now(); }
function mastered(q){ var r = R(q.id); return !!r && r.box >= 2; }
function answer(q, ok){
  var r = st.quiz[q.id] || (st.quiz[q.id] = { box:0, due:0, h:[] });
  r.h.push([Date.now(), ok ? 1 : 0]); if (r.h.length > 20) r.h = r.h.slice(-20);
  if (ok){ r.box = Math.min(r.box + 1, SR_DAYS.length - 1); r.due = Date.now() + SR_DAYS[r.box] * DAY; }
  else { r.box = 0; r.due = Date.now() + 1 * DAY; }   /* 間違えたら翌日に出し直す */
  logAdd('q', 1); if (ok) logAdd('c', 1);
  save();
}
function dueList(){ return Q.filter(isDue); }

/* ================= 合格の見込み ================= */
function phi(z){ var t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2); var p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }
function domainStats(){
  var now = Date.now(), out = {};
  S.forEach(function(s){
    var L = Math.min(A(s.id).count, 3), pm = 0.5 + 0.05 * L, ps = 3;     /* 何も解いていないときの仮置き。聞いた回数で少し上げる */
    var al = pm * ps, be = (1 - pm) * ps, n = 0, tot = 0, recent = [];
    Q.forEach(function(q){
      if (q.s !== s.id) return; tot++;
      var r = R(q.id); if (!r || !r.h.length) return; n++;
      var ws = 0, wc = 0, wm = 0;
      r.h.forEach(function(x){ var w = Math.pow(0.5, (now - x[0]) / DAY / 21); ws += w; wc += w * x[1]; wm = Math.max(wm, w); recent.push(x); });
      var qs = wc / ws; al += wm * qs; be += wm * (1 - qs);
    });
    var m = al / (al + be), v = al * be / ((al + be) * (al + be) * (al + be + 1));
    out[s.id] = { m:m, v:v, n:n, tot:tot, real:clamp(m - GAP, 0, 1) };
  });
  return out;
}
function weightsN(){ var w = st.settings.weights, t = 0, o = {}; SID.forEach(function(id){ t += Math.max(0, Number(w[id]) || 0); }); SID.forEach(function(id){ o[id] = t ? Math.max(0, Number(w[id]) || 0) / t : 1 / SID.length; }); return o; }
function estimateFrom(ds){
  var W = weightsN(), mu = 0, v = 0;
  SID.forEach(function(id){ mu += W[id] * ds[id].real; v += W[id] * W[id] * ds[id].v; });
  v += mu * (1 - mu) / N_EXAM + MODEL_SD * MODEL_SD;
  var sd = Math.sqrt(v), pl = st.settings.passLine / 100;
  return { mu:mu, sd:sd, p:phi((mu - pl) / sd) };
}
function estimate(){
  var ds = domainStats(), e = estimateFrom(ds), answered = 0;
  SID.forEach(function(id){ answered += ds[id].n; });
  e.ds = ds; e.answered = answered;
  e.conf = answered >= 50 ? '高' : answered >= 25 ? '中' : '低';
  /* 分野ごとに「85%まで上げたら合格の見込みがどれだけ上がるか」 */
  var W = weightsN();
  e.gain = SID.map(function(id){
    var c = JSON.parse(JSON.stringify(ds)); if (c[id].real < 0.85){ c[id].real = 0.85; c[id].v = c[id].v / 2; }
    return { id:id, d:estimateFrom(c).p - e.p, real:ds[id].real, w:W[id] };
  }).sort(function(a, b){ return b.d - a.d; });
  if (answered >= 10){ st.est[dkey()] = { p:Math.round(e.p * 1000) / 1000, mu:Math.round(e.mu * 1000) / 1000 }; save(); }
  return e;
}

/* ================= 試験日とペース ================= */
function daysLeft(){
  var p = (st.settings.examDate || '').split('-').map(Number); if (p.length !== 3 || !p[0]) return null;
  var ex = new Date(p[0], p[1] - 1, p[2]), t = new Date(); t.setHours(0,0,0,0);
  return Math.round((ex - t) / DAY);
}
function recentAvg(days){
  /* 使い始めて7日未満なら、使った日数で割る(初日に不当に低く出ないように) */
  var first = Object.keys(st.log).sort()[0];
  if (first){ var fp = first.split('-').map(Number), t0 = new Date(fp[0], fp[1] - 1, fp[2]), t1 = new Date(); t1.setHours(0,0,0,0); days = clamp(Math.round((t1 - t0) / DAY) + 1, 1, days); }
  var l = 0, q = 0, act = 0;
  for (var i = 0; i < days; i++){ var d = new Date(Date.now() - i * DAY), r = st.log[dkey(d)]; if (r){ l += r.listen || 0; q += r.q || 0; if ((r.listen || 0) > 60 || (r.q || 0) > 0) act++; } }
  return { listen:l / days, q:q / days, active:act };
}
function streak(){ var n = 0; for (var i = 0; i < 400; i++){ var r = st.log[dkey(new Date(Date.now() - i * DAY))]; if (r && ((r.listen || 0) > 60 || (r.q || 0) > 0)) n++; else if (i > 0) break; } return n; }
function pace(){
  var D = daysLeft(), T = st.settings.targetListens, remSec = 0, total = 0, anyDur = false;
  S.forEach(function(s){ var a = A(s.id), d = a.dur || DEFAULT_DUR; if (a.dur) anyDur = true; total += T * d; remSec += Math.max(0, T - a.count - coverage(a)) * d; });
  var remQ = Q.filter(function(q){ return !mastered(q); }).length;
  var res = { D:D, remSec:remSec, totalSec:total, remQ:remQ, anyDur:anyDur };
  if (D == null){ res.level = 'na'; res.label = '試験日が未設定'; return res; }
  if (D < 0){ res.level = 'na'; res.label = '試験日を過ぎました'; return res; }
  var eff = Math.max(1, D - 2);                 /* 直前2日は総復習にあてる */
  res.eff = eff; res.needListen = remSec / eff; res.needQ = remQ / eff;
  var act = recentAvg(7); res.act = act;
  if (remSec <= 0 && remQ <= 0){ res.level = 'ok'; res.label = '計画の分は達成'; return res; }
  if (act.active === 0){ res.level = 'na'; res.label = 'まだ記録がありません'; return res; }
  var ratios = [];
  if (res.needListen > 0) ratios.push(act.listen / res.needListen);
  if (res.needQ > 0) ratios.push(act.q / res.needQ);
  var r = Math.min.apply(null, ratios); res.ratio = r;
  if (r >= 1.2){ res.level = 'ok'; res.label = '余裕あり'; }
  else if (r >= 0.9){ res.level = 'ok'; res.label = '順調'; }
  else if (r >= 0.6){ res.level = 'warn'; res.label = '少しペースアップを'; }
  else { res.level = 'ng'; res.label = '要ペースアップ'; }
  return res;
}

/* ================= 画面の切り替え ================= */
var VIEWS = ['home','listen','quiz','learn','settings'], view = 'home';
function go(v, opt){
  if (VIEWS.indexOf(v) < 0) v = 'home';
  view = v;
  $$('.view').forEach(function(el){ el.classList.toggle('on', el.id === 'v-' + v); });
  $$('.nav button').forEach(function(b){ if (b.dataset.go === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  if (location.hash !== '#' + v){ try { history.replaceState(null, '', '#' + v); } catch (e) {} }
  render(v, opt);
  if (!opt || !opt.keepScroll) window.scrollTo(0, 0);
}
function render(v, opt){
  if (v === 'home') renderHome();
  if (v === 'listen') renderPlayer();
  if (v === 'quiz') renderQuiz(opt);
  if (v === 'learn') renderLearn(opt);
  if (v === 'settings') renderSettings();
}
function renderAll(){ render(view, { keepScroll:true }); renderMini(); renderBar(); }
document.addEventListener('click', function(e){
  var b = e.target.closest('[data-go]'); if (b){ e.preventDefault(); go(b.dataset.go); }
});
window.addEventListener('hashchange', function(){ var v = location.hash.slice(1); if (v !== view && VIEWS.indexOf(v) >= 0) go(v); });

/* 表示モード(自動 / PC / スマホ) */
var mq = window.matchMedia('(min-width: 900px)');
function applyMode(){
  var m = st.settings.viewMode, pc = m === 'pc' || (m === 'auto' && mq.matches);
  document.body.classList.toggle('m-pc', pc); document.body.classList.toggle('m-sp', !pc);
  $('#modeBtn').textContent = '表示: ' + (m === 'auto' ? '自動(' + (pc ? 'PC' : 'スマホ') + ')' : m === 'pc' ? 'PC' : 'スマホ');
}
$('#modeBtn').addEventListener('click', function(){
  var order = ['auto','pc','sp']; st.settings.viewMode = order[(order.indexOf(st.settings.viewMode) + 1) % 3]; save(); applyMode(); renderAll();
});
if (mq.addEventListener) mq.addEventListener('change', applyMode); else if (mq.addListener) mq.addListener(applyMode);

function renderBar(){ var D = daysLeft(); $('#barCount').textContent = D == null ? '' : D >= 0 ? '試験まで あと' + D + '日' : '試験日を過ぎました'; }

/* ================= ホーム ================= */
function renderHome(){
  var e = estimate(), pc = pace(), D = daysLeft(), due = dueList().length, today = st.log[dkey()] || { listen:0, q:0, c:0 };
  var h = '<h1 class="vt">ホーム</h1>';
  /* 試験日とペース */
  h += '<div class="grid2"><div class="card dark"><h2 class="st">試験日まで</h2>';
  h += '<div class="big">' + (D == null ? '-' : Math.max(D, 0)) + '<small>日</small></div>';
  h += '<div class="small" style="margin-top:4px">' + esc(st.settings.examDate) + '(設定で変更できます)</div>';
  h += '<div style="margin-top:10px"><span class="pill ' + (pc.level === 'ok' ? 'ok' : pc.level === 'warn' ? 'warn' : pc.level === 'ng' ? 'ng' : 'na') + '">ペース: ' + esc(pc.label) + '</span></div>';
  if (pc.eff){
    h += '<dl class="kv"><dt>残りの音声</dt><dd>' + fmtMin(pc.remSec) + (pc.anyDur ? '' : '(仮の長さで計算)') + '</dd>';
    h += '<dt>未定着の問題</dt><dd>' + pc.remQ + '問</dd>';
    h += '<dt>必要なペース</dt><dd>1日 ' + fmtMin(pc.needListen) + ' + ' + (Math.ceil(pc.needQ * 10) / 10) + '問</dd>';
    if (pc.act) h += '<dt>直近7日の実績</dt><dd>1日 ' + fmtMin(pc.act.listen) + ' + ' + (Math.round(pc.act.q * 10) / 10) + '問</dd>';
    h += '</dl><p class="small" style="margin:8px 0 0;color:#cfd4de">目標: 各シナリオを' + st.settings.targetListens + '回聞く + 全問を2回以上続けて正解。直前2日は総復習用に空けて計算しています。</p>';
  }
  h += '</div>';

  /* 合格の見込み */
  h += '<div class="card"><h2 class="st">合格の見込み</h2>';
  if (e.answered < 10){
    h += '<p>小テストを<b>あと' + (10 - e.answered) + '問</b>解くと表示します。</p><p class="note">分野ごとの正答率・出題の重み・最近の成績・聞いた回数から計算します。</p>';
  } else {
    var lo = clamp(e.mu - e.sd, 0, 1), hi = clamp(e.mu + e.sd, 0, 1);
    h += '<div class="row" style="align-items:flex-end;gap:14px"><div class="big">' + pct(e.p) + '<small>%</small></div><div class="small">推定の本番正答率 <b>' + pct(e.mu) + '%</b>(' + pct(lo) + '〜' + pct(hi) + '%)<br>145問なら 約' + Math.round(e.mu * N_EXAM) + '問正解 / データの信頼度: <b>' + e.conf + '</b></div></div>';
    h += '<div class="gauge" aria-hidden="true"><u style="left:' + (lo * 100) + '%;width:' + ((hi - lo) * 100) + '%"></u><i style="width:' + (e.mu * 100) + '%;opacity:.25"></i><b style="left:' + st.settings.passLine + '%"></b></div>';
    h += '<div class="small muted">赤い線が合格ラインの目安(' + st.settings.passLine + '%)。枠は推定のぶれの幅です。</div>';
    h += '<div class="dom">';
    SID.forEach(function(id){ var d = e.ds[id], s = sc(id);
      h += '<div class="lab" style="color:' + s.ac + '">' + s.no + ' ' + esc(s.title) + '</div><div class="bar" style="' + scStyle(id) + '"><i style="width:' + (d.real * 100) + '%"></i><b style="left:' + st.settings.passLine + '%"></b></div><div class="val">' + (d.n ? pct(d.real) + '%' : '未') + '</div>'; });
    h += '</div>';
    var g = e.gain.filter(function(x){ return x.d > 0.005; }).slice(0, 3);
    if (g.length){ h += '<h3 style="font-size:14.5px;margin:12px 0 4px">伸ばすと効く分野</h3><ol style="margin:0;padding-left:1.4em;font-size:14px">';
      g.forEach(function(x){ h += '<li>' + sc(x.id).no + ' ' + esc(sc(x.id).title) + ': 85%まで上げると <b>+' + pct(x.d) + 'ポイント</b></li>'; }); h += '</ol>'; }
    h += sparkline();
    h += '<p class="note">目安です。合格ラインは公式非公開のため正答率' + st.settings.passLine + '%と仮定。アプリの問題は台本から出るので、本番は' + pct(GAP) + 'ポイント低く見積もっています。分野の重みは設定で変えられます。</p>';
  }
  h += '</div></div>';

  /* 今日やること */
  h += '<div class="grid2"><div class="card"><h2 class="st">今日のおすすめ</h2><div class="todo">' + todoHtml(e, due) + '</div>';
  h += '<dl class="kv"><dt>今日聞いた時間</dt><dd>' + fmtMin(today.listen) + '</dd><dt>今日解いた問題</dt><dd>' + (today.q || 0) + '問(正解 ' + (today.c || 0) + ')</dd><dt>連続学習</dt><dd>' + streak() + '日</dd></dl></div>';
  h += '<div class="card"><h2 class="st">聞いた進捗</h2><div class="slist">' + scenarioRows() + '</div><p class="note">バーの色付きの部分が今回聞いた範囲。9割聞くと1回としてカウントします。</p></div></div>';
  $('#v-home').innerHTML = h;
}
function sparkline(){
  var ks = Object.keys(st.est).sort().slice(-30); if (ks.length < 2) return '<p class="note">合格の見込みの推移は、2日以上記録がたまると表示します。</p>';
  var W = 300, H = 60, pl = st.settings.passLine;
  var pts = ks.map(function(k, i){ return [i / (ks.length - 1) * (W - 8) + 4, H - 6 - st.est[k].p * (H - 12)]; });
  var path = pts.map(function(p, i){ return (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
  var last = pts[pts.length - 1];
  return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="合格の見込みの推移"><line x1="0" x2="' + W + '" y1="' + (H - 6 - 0.5 * (H - 12)) + '" y2="' + (H - 6 - 0.5 * (H - 12)) + '" stroke="#bcc3cf" stroke-dasharray="3 3"/><path d="' + path + ' L' + last[0] + ',' + (H - 6) + ' L4,' + (H - 6) + ' Z" fill="#15171c" opacity=".08"/><path d="' + path + '" fill="none" stroke="#15171c" stroke-width="2.5" vector-effect="non-scaling-stroke"/><circle cx="' + last[0] + '" cy="' + last[1] + '" r="4" fill="#15171c"/></svg><div class="small muted" style="display:flex;justify-content:space-between"><span>' + ks[0].slice(5).replace('-', '/') + '</span><span>点線=50%</span><span>' + ks[ks.length - 1].slice(5).replace('-', '/') + '</span></div>';
}
function todoHtml(e, due){
  var items = [];
  if (due) items.push('<button type="button" data-act="quiz-due"><b>復習問題を解く(' + due + '問)</b><span>前に間違えた問題・出し直しの日が来た問題</span></button>');
  var cand = SID.map(function(id){ var a = A(id); return { id:id, v:a.count + coverage(a), has:hasFile[id] }; }).filter(function(x){ return x.v < st.settings.targetListens; })
    .sort(function(a, b){ return a.v - b.v; });
  if (cand.length){ var c = cand[0], s = sc(c.id), a = A(c.id);
    items.push('<button type="button" data-act="listen" data-id="' + c.id + '"><b>' + s.no + ' ' + esc(s.title) + ' を聞く</b><span>' + (c.has ? (a.pos > 5 ? '続き(' + fmtT(a.pos) + ')から' : '最初から') + ' / ' + a.count + '回聞いた' : '音声ファイルがまだ登録されていません') + '</span></button>'); }
  if (e.answered >= 10){ var w = e.gain[0]; if (w && w.d > 0.005) items.push('<button type="button" data-act="quiz-sc" data-id="' + w.id + '"><b>' + sc(w.id).no + ' ' + esc(sc(w.id).title) + ' の小テスト</b><span>伸ばすと一番効く分野</span></button>'); }
  var fresh = Q.filter(function(q){ return !R(q.id); }).length;
  if (fresh) items.push('<button type="button" data-act="quiz-new"><b>まだ解いていない問題(' + Math.min(10, fresh) + '問)</b><span>残り' + fresh + '問</span></button>');
  if (!items.length) items.push('<button type="button" data-act="quiz-mock"><b>模試風20問</b><span>出題の重みに合わせて全分野から出題</span></button>');
  return items.join('');
}
function scenarioRows(){
  return S.map(function(s){ var a = A(s.id);
    return '<button type="button" class="srow' + (s.id === cur ? ' cur' : '') + '" style="' + scStyle(s.id) + '" data-act="listen" data-id="' + s.id + '"><span class="no">' + s.no + '</span><span class="tt">' + esc(s.title) + '<small>' + (hasFile[s.id] ? (a.dur ? fmtT(a.pos) + ' / ' + fmtT(a.dur) + ' ・今回 ' + pct(coverage(a)) + '%' : '登録済み') : '音声ファイル未登録') + '</small></span><span class="cnt">' + a.count + '回</span><span class="hb"><span class="heard">' + heardBar(s.id) + '</span></span></button>'; }).join('');
}
document.addEventListener('click', function(e){
  var b = e.target.closest('[data-act]'); if (!b) return;
  var act = b.dataset.act, id = b.dataset.id;
  if (act === 'listen'){ if (id !== cur || !au.src) loadScenario(id, { play: hasFile[id] }).then(function(){ go('listen'); }); else { go('listen'); } }
  if (act === 'quiz-due') startQuiz('due');
  if (act === 'quiz-new') startQuiz('new');
  if (act === 'quiz-mock') startQuiz('mock');
  if (act === 'quiz-weak') startQuiz('weak');
  if (act === 'quiz-rand') startQuiz('rand');
  if (act === 'quiz-sc') startQuiz('sc', id);
  if (act === 'hear'){ hearPart(id, Number(b.dataset.p)); }
  if (act === 'read'){ go('learn', { sc:id, part:Number(b.dataset.p) }); }
});
function hearPart(id, p){
  var go2 = function(){ go('listen'); if (au.src){ gotoCh(p, true); toast(sc(id).no + ' のパート' + (p + 1) + 'から再生します'); } };
  if (cur !== id || !au.src) loadScenario(id).then(go2); else go2();
}

/* ================= 聞く ================= */
function renderPlayer(){
  var el = $('#v-listen'); if (!el) return;
  var id = cur || SID[0]; if (!cur){ cur = id; }
  var s = sc(id), a = A(id), loaded = !!au.src && hasFile[id];
  var h = '<h1 class="vt">聞く</h1><div class="grid2"><div>';
  h += '<div class="card now" style="' + scStyle(id) + '"><div class="row" style="justify-content:space-between"><span class="tag">シナリオ' + s.no + '</span><span class="cnt pill na">' + a.count + '回聞いた</span></div><h2 style="margin-top:6px">' + esc(s.title) + '</h2>';
  if (!hasFile[id]){
    h += '<div class="drop" style="margin-top:10px"><p style="margin:0 0 8px">このシナリオの音声ファイルを選んでください。<br><span class="small muted">一度選べば端末の中に保存され、次からは選び直し不要です。</span></p><button type="button" class="btn pri" id="pickBtn">音声ファイルを選ぶ</button></div>';
  } else {
    var k = chAt(id, a.pos);
    h += '<div class="chtitle" id="chTitle">パート' + (k + 1) + ': ' + esc(CH[id].list[k][0]) + (loopCh != null ? ' ・くり返し中' : '') + '</div>';
    h += '<div class="vis" id="vis">' + heardBar(id, true) + '</div>';
    h += '<input type="range" class="seek" id="seek" min="0" max="' + (a.dur || 0) + '" step="1" value="' + (a.pos || 0) + '" aria-label="再生位置">';
    h += '<div class="times"><span id="tCur">' + fmtT(a.pos) + '</span><span>今回 ' + pct(coverage(a)) + '% 聞いた</span><span id="tDur">' + fmtT(a.dur) + '</span></div>';
    h += '<div class="ctrl"><button type="button" class="ib s" id="pPrev" aria-label="前のパート">|◀</button><button type="button" class="ib" id="pBack" aria-label="5秒戻す">-5秒</button><button type="button" class="ib play" id="pPlay" aria-label="再生">' + (au.paused ? '▶' : '❚❚') + '</button><button type="button" class="ib" id="pFwd" aria-label="5秒進む">+5秒</button><button type="button" class="ib s" id="pNext" aria-label="次のパート">▶|</button></div>';
    h += '<div class="opt"><span>速度</span><div class="seg" id="rates">' + RATES.map(function(r){ return '<button type="button" data-rate="' + r + '" aria-pressed="' + (st.settings.rate === r) + '">' + r + '×</button>'; }).join('') + '</div>';
    h += '<span>スリープ</span><div class="row"><select id="sleepSel" aria-label="スリープタイマー"><option value="off">オフ</option><option value="10">10分後</option><option value="15">15分後</option><option value="30">30分後</option><option value="45">45分後</option><option value="60">60分後</option><option value="ch">このパートの終わり</option><option value="file">この音声の終わり</option></select><span class="small" id="sleepLab">' + sleepLabel() + '</span></div>';
    h += '<span>自動で次へ</span><label class="row small"><input type="checkbox" id="autoNext"' + (st.settings.autoNext ? ' checked' : '') + '> 終わったら次のシナリオを再生</label></div>';
    if (!loaded) h += '<p class="note">音声を準備しています…</p>';
    h += '<div class="row" style="margin-top:12px"><span class="small muted" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(a.name || '') + '</span><button type="button" class="btn sm" id="pickBtn">ファイルを変更</button></div>';
  }
  h += '</div>';
  h += '<div class="card"><h2 class="st">シナリオを選ぶ</h2><div class="slist">' + scenarioRows() + '</div></div></div>';

  /* パート一覧 */
  h += '<div class="card" style="' + scStyle(id) + '"><h2 class="st">パート(頭出し・くり返し)</h2>';
  if (hasFile[id]){
    var starts = chStarts(id), k2 = chAt(id, a.pos);
    h += '<div class="chs">';
    CH[id].list.forEach(function(c, i){
      var r = chRange(id, i);
      h += '<div class="chrow' + (i === k2 ? ' cur' : '') + '"><div class="h"><b>' + (i + 1) + '. ' + esc(c[0]) + '</b><span>' + fmtT(r[0]) + '〜' + fmtT(r[1]) + (st.cal[id] && st.cal[id][i] != null ? ' ・調整済み' : ' ・推定') + '</span></div><div class="mbar"><i style="width:' + pct(chHeard(id, i)) + '%"></i></div>'
        + '<div class="acts"><button type="button" class="btn sm" data-ch="' + i + '" data-do="play">ここから再生</button><button type="button" class="btn sm' + (loopCh === i ? ' pri' : '') + '" data-ch="' + i + '" data-do="loop">' + (loopCh === i ? 'くり返し中' : 'くり返す') + '</button>' + (i > 0 ? '<button type="button" class="btn sm" data-ch="' + i + '" data-do="cal">今の位置を開始にする</button>' : '') + '</div></div>';
    });
    h += '</div><p class="note">パートの位置は台本の文字数から推定しています。ずれていたら、そのパートの始まりで一時停止して「今の位置を開始にする」を押してください。</p>';
  } else h += '<p class="muted">音声ファイルを登録すると、パートごとの頭出しとくり返しが使えます。</p>';
  h += '</div>';
  el.innerHTML = h;
  bindPlayer();
  if (hasFile[id] && !au.src && cur === id) loadScenario(id);
}
function bindPlayer(){
  var p = $('#pickBtn'); if (p) p.addEventListener('click', function(){ $('#filePick').click(); });
  var b = function(sel, f){ var x = $(sel); if (x) x.addEventListener('click', f); };
  b('#pPlay', togglePlay); b('#pBack', function(){ seekBy(-5); }); b('#pFwd', function(){ seekBy(5); }); b('#pPrev', prevCh); b('#pNext', nextCh);
  var sk = $('#seek'); if (sk){ sk.addEventListener('input', function(){ $('#tCur').textContent = fmtT(sk.value); }); sk.addEventListener('change', function(){ seekTo(Number(sk.value)); }); }
  $$('#rates button').forEach(function(x){ x.addEventListener('click', function(){ setRate(Number(x.dataset.rate)); }); });
  var ss = $('#sleepSel'); if (ss){ ss.value = sleep.mode === 'ch' ? 'ch' : sleep.mode === 'file' ? 'file' : 'off'; ss.addEventListener('change', function(){ setSleep(ss.value); }); }
  var an = $('#autoNext'); if (an) an.addEventListener('change', function(){ st.settings.autoNext = an.checked; save(); });
  $$('[data-ch]').forEach(function(x){ x.addEventListener('click', function(){
    var i = Number(x.dataset.ch), d = x.dataset.do;
    if (!au.src){ toast('音声を準備しています'); return; }
    if (d === 'play'){ loopCh = null; gotoCh(i, true); }
    if (d === 'loop'){ loopCh = loopCh === i ? null : i; if (loopCh != null) gotoCh(i, true); toast(loopCh != null ? 'パート' + (i + 1) + 'をくり返します' : 'くり返しを止めました'); }
    if (d === 'cal'){ st.cal[cur] = st.cal[cur] || {}; st.cal[cur][i] = au.currentTime; save(); toast('パート' + (i + 1) + 'の開始を ' + fmtT(au.currentTime) + ' にしました'); }
    renderPlayer();
  }); });
}
var lastPaint = 0;
function updateProgress(){
  var now = Date.now(); if (now - lastPaint < 400) return; lastPaint = now;
  var a = A(cur);
  var fill = $('#miniFill'); if (fill && a.dur) fill.style.width = (a.pos / a.dur * 100) + '%';
  if (view === 'listen'){
    var sk = $('#seek'); if (sk && document.activeElement !== sk){ sk.max = a.dur || 0; sk.value = a.pos; }
    var tc = $('#tCur'); if (tc) tc.textContent = fmtT(a.pos);
    var v = $('#vis'); if (v) v.innerHTML = heardBar(cur, true);
    var k = chAt(cur, a.pos), ct = $('#chTitle');
    if (ct) ct.textContent = 'パート' + (k + 1) + ': ' + CH[cur].list[k][0] + (loopCh != null ? ' ・くり返し中' : '');
    if (k !== lastChShown){ lastChShown = k; setMeta(); $$('.chrow').forEach(function(r, i){ r.classList.toggle('cur', i === k); }); }
    var sl = $('#sleepLab'); if (sl) sl.textContent = sleepLabel();
  } else if (chAt(cur, a.pos) !== lastChShown){ lastChShown = chAt(cur, a.pos); setMeta(); }
  setPosState();
}
function renderSleep(){ var sl = $('#sleepLab'); if (sl) sl.textContent = sleepLabel(); var ss = $('#sleepSel'); if (ss && !sleep.mode) ss.value = 'off'; }
function renderPlayState(){
  var t = au.paused ? '▶' : '❚❚', l = au.paused ? '再生' : '一時停止';
  ['#pPlay','#miniPlay'].forEach(function(s){ var x = $(s); if (x){ x.textContent = t; x.setAttribute('aria-label', l); } });
  try { navigator.mediaSession.playbackState = au.paused ? 'paused' : 'playing'; } catch (e) {}
}
function renderMini(){
  var m = $('#mini'); if (!cur || !hasFile[cur]){ m.hidden = true; return; }
  m.hidden = false; m.style.setProperty('--ac', sc(cur).ac);
  $('#miniTitle').textContent = sc(cur).no + ' ' + sc(cur).title;
  var a = A(cur); $('#miniFill').style.width = a.dur ? (a.pos / a.dur * 100) + '%' : '0';
  renderPlayState();
}
$('#miniPlay').addEventListener('click', function(){ if (!au.src && cur) loadScenario(cur, { play:true }); else togglePlay(); });
$('#miniBack').addEventListener('click', function(){ seekBy(-5); });
$('#miniFwd').addEventListener('click', function(){ seekBy(5); });

$('#filePick').addEventListener('change', function(e){
  var f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
  var id = cur;
  toast('保存しています…');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function(){});
  idb.put(id, { blob:f, name:f.name, size:f.size, type:f.type, at:Date.now() }).then(function(){
    var a = A(id); a.name = f.name; a.dur = 0; a.pos = 0; a.heard = ''; hasFile[id] = true; save(true);
    return loadScenario(id, { seek:0 });
  }).then(function(){ toast('音声を保存しました'); renderAll(); }).catch(function(){ toast('保存できませんでした。空き容量を確認してください'); });
});

/* ================= 小テスト ================= */
var qs = null; /* セッション */
function pickWeighted(n){
  var W = weightsN(), out = [], pools = {};
  SID.forEach(function(id){ pools[id] = shuffle(Q.filter(function(q){ return q.s === id; })); });
  SID.forEach(function(id){ var k = Math.round(W[id] * n); out = out.concat(pools[id].slice(0, k)); });
  return shuffle(out).slice(0, n);
}
function startQuiz(mode, id){
  var list = [], title = '';
  if (mode === 'due'){ list = shuffle(dueList()).slice(0, 15); title = '復習問題'; }
  if (mode === 'new'){ list = shuffle(Q.filter(function(q){ return !R(q.id); })).slice(0, 10); title = 'まだ解いていない問題'; }
  if (mode === 'rand'){ list = shuffle(Q).slice(0, 10); title = 'ランダム10問'; }
  if (mode === 'mock'){ list = pickWeighted(20); title = '模試風20問'; }
  if (mode === 'sc'){ list = shuffle(Q.filter(function(q){ return q.s === id; })); title = sc(id).no + ' ' + sc(id).title; }
  if (mode === 'weak'){
    var ds = domainStats();
    list = Q.slice().sort(function(a, b){
      var ra = R(a.id), rb = R(b.id), sa = ra ? ra.box : 0.5, sb = rb ? rb.box : 0.5;
      return (sa + ds[a.s].real * 3) - (sb + ds[b.s].real * 3) + (Math.random() - 0.5) * 0.3; }).slice(0, 10);
    title = '苦手分野から10問';
  }
  if (!list.length){ toast('出題できる問題がありません'); return; }
  qs = { title:title, list:list, i:0, results:[], answered:false, order:null };
  go('quiz');
}
function renderQuiz(){
  var el = $('#v-quiz');
  if (qs && qs.i < qs.list.length){ el.innerHTML = quizQ(); bindQuizQ(); return; }
  if (qs && qs.i >= qs.list.length){ el.innerHTML = quizResult(); $('#qBack').addEventListener('click', function(){ qs = null; renderQuiz(); }); return; }
  var due = dueList().length, tried = Q.filter(function(q){ return R(q.id); }).length, mas = Q.filter(mastered).length;
  var h = '<h1 class="vt">小テスト</h1><div class="card"><dl class="kv"><dt>解いた問題</dt><dd>' + tried + ' / ' + Q.length + '問</dd><dt>定着した問題</dt><dd>' + mas + '問(2回以上続けて正解)</dd><dt>今日の復習</dt><dd>' + due + '問</dd></dl></div>';
  h += '<div class="card"><h2 class="st">出題のしかたを選ぶ</h2><div class="qbtns">'
    + '<button type="button" class="btn pri" data-act="quiz-due"' + (due ? '' : ' disabled') + '>復習問題(' + due + ')<small>間違えた問題を日にちを空けて出し直し</small></button>'
    + '<button type="button" class="btn" data-act="quiz-weak">苦手分野から10問<small>正答率の低い分野を優先</small></button>'
    + '<button type="button" class="btn" data-act="quiz-new">まだ解いていない問題<small>' + (Q.length - tried) + '問残り</small></button>'
    + '<button type="button" class="btn" data-act="quiz-rand">ランダム10問<small>全分野から</small></button>'
    + '<button type="button" class="btn" data-act="quiz-mock">模試風20問<small>出題の重みに合わせて配分</small></button></div></div>';
  h += '<div class="card"><h2 class="st">シナリオ別</h2><div class="slist">';
  var ds = domainStats();
  S.forEach(function(s){ var n = Q.filter(function(q){ return q.s === s.id; }).length, d = ds[s.id];
    h += '<button type="button" class="srow" style="' + scStyle(s.id) + '" data-act="quiz-sc" data-id="' + s.id + '"><span class="no">' + s.no + '</span><span class="tt">' + esc(s.title) + '<small>' + n + '問 ・解いた ' + d.n + '問' + (d.n ? ' ・推定正答率 ' + pct(d.m) + '%' : '') + '</small></span><span class="cnt">' + n + '問</span></button>'; });
  h += '</div></div>';
  el.innerHTML = h;
}
function quizQ(){
  var q = qs.list[qs.i], s = sc(q.s);
  if (!qs.order) qs.order = shuffle([0, 1, 2, 3]);
  var h = '<h1 class="vt">' + esc(qs.title) + '</h1><div class="card" style="' + scStyle(q.s) + '"><div class="qhead"><span><span class="tag">' + s.no + '</span>' + esc(CH[q.s].list[q.p][0]) + '</span><span>' + (qs.i + 1) + ' / ' + qs.list.length + '</span></div>';
  h += '<div class="qtext">' + esc(q.q) + '</div><div class="choices">';
  qs.order.forEach(function(k, n){
    var cls = '';
    if (qs.answered){ if (k === 0) cls = ' ok'; else if (k === qs.picked) cls = ' ng'; }
    h += '<button type="button" class="choice' + cls + '" data-k="' + k + '"' + (qs.answered ? ' disabled' : '') + '>' + 'ABCD'.charAt(n) + '. ' + esc(q.ch[k]) + '</button>';
  });
  h += '</div>';
  if (qs.answered){
    var ok = qs.picked === 0;
    h += '<div class="fb ' + (ok ? 'ok' : 'ng') + '"><b>' + (ok ? '正解' : '不正解。正解は「' + esc(q.ch[0]) + '」') + '</b>' + esc(q.ex) + '</div>';
    h += '<div class="row" style="margin-top:12px"><button type="button" class="btn" data-act="hear" data-id="' + q.s + '" data-p="' + q.p + '">音声でこのパートを聞く</button><button type="button" class="btn" data-act="read" data-id="' + q.s + '" data-p="' + q.p + '">要点を見る</button><button type="button" class="btn pri" id="qNext" style="margin-left:auto">' + (qs.i + 1 < qs.list.length ? '次へ' : '結果を見る') + '</button></div>';
  }
  return h + '</div>';
}
function bindQuizQ(){
  $$('.choice').forEach(function(b){ b.addEventListener('click', function(){
    if (qs.answered) return; var q = qs.list[qs.i], k = Number(b.dataset.k);
    qs.answered = true; qs.picked = k; answer(q, k === 0); qs.results.push({ q:q, ok:k === 0 }); renderQuiz(); renderBar();
  }); });
  var n = $('#qNext'); if (n) n.addEventListener('click', function(){ qs.i++; qs.answered = false; qs.order = null; renderQuiz(); window.scrollTo(0, 0); });
}
function quizResult(){
  var ok = qs.results.filter(function(r){ return r.ok; }).length, n = qs.results.length;
  var h = '<h1 class="vt">結果: ' + esc(qs.title) + '</h1><div class="card"><div class="big">' + ok + '<small>/ ' + n + '問 正解(' + pct(n ? ok / n : 0) + '%)</small></div><p class="note">間違えた問題は翌日に、正解した問題は日にちを空けて、復習問題として出し直します。</p></div>';
  var wr = qs.results.filter(function(r){ return !r.ok; });
  if (wr.length){
    h += '<div class="card"><h2 class="st">間違えた問題</h2>';
    wr.forEach(function(r){ var q = r.q; h += '<div class="wrong" style="' + scStyle(q.s) + '"><div><span class="tag">' + sc(q.s).no + '</span><b>' + esc(q.q) + '</b></div><div class="small" style="margin:4px 0">正解: ' + esc(q.ch[0]) + '</div><div class="row"><button type="button" class="btn sm" data-act="hear" data-id="' + q.s + '" data-p="' + q.p + '">音声で聞き直す</button><button type="button" class="btn sm" data-act="read" data-id="' + q.s + '" data-p="' + q.p + '">要点を見る</button></div></div>'; });
    h += '</div>';
  }
  return h + '<button type="button" class="btn pri" id="qBack">出題メニューへ</button>';
}

/* ================= 学ぶ(要点シート) ================= */
function rFlow(items){ return '<div class="flow">' + items.map(function(it, i){ return (i ? '<span class="arr" aria-hidden="true">→</span>' : '') + '<div class="step"><b>' + esc(it[0]) + '</b>' + (it[1] ? '<small>' + esc(it[1]) + '</small>' : '') + '</div>'; }).join('') + '</div>'; }
function rTerms(rows){ return '<div class="terms">' + rows.map(function(r){ return '<div class="k">' + esc(r[0]) + '</div><div class="v">' + esc(r[1]) + '</div>'; }).join('') + '</div>'; }
function rCmp(head, rows){ return '<div class="tw"><table><thead><tr>' + head.map(function(c){ return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.map(function(r){ return '<tr>' + r.map(function(c){ return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>'; }
function rBlock(b){ if (b[0] === 'flow') return rFlow(b[1]); if (b[0] === 'terms') return rTerms(b[1]); if (b[0] === 'cmp') return rCmp(b[1], b[2]); return '<div class="tip"><b>試験ポイント</b>' + esc(b[1]) + '</div>'; }
var learnSel = 'map';
function renderLearn(opt){
  if (opt && opt.sc) learnSel = opt.sc;
  var el = $('#v-learn');
  var h = '<h1 class="vt">学ぶ(要点シート)</h1><div class="chips" role="group" aria-label="シナリオ">';
  h += '<button type="button" data-ls="map" aria-pressed="' + (learnSel === 'map') + '">全体</button>';
  S.forEach(function(s){ h += '<button type="button" data-ls="' + s.id + '" style="--c:' + s.ac + '" aria-pressed="' + (learnSel === s.id) + '">' + s.no + ' ' + esc(s.title) + '</button>'; });
  h += '</div><input type="search" id="lq" placeholder="用語で全シナリオを検索(例: ReLU、適合率)" aria-label="用語で検索" style="width:100%;margin-bottom:12px">';
  h += '<div id="lbody">' + learnBody() + '</div>';
  el.innerHTML = h;
  $$('[data-ls]').forEach(function(b){ b.addEventListener('click', function(){ learnSel = b.dataset.ls; renderLearn(); }); });
  var lq = $('#lq'); lq.addEventListener('input', function(){ var q = lq.value.trim().toLowerCase(); $('#lbody').innerHTML = q ? learnSearch(q) : learnBody(); bindLearn(); });
  bindLearn();
  if (opt && opt.part != null){ var t = document.getElementById('part-' + learnSel + '-' + opt.part); if (t) setTimeout(function(){ t.scrollIntoView({ block:'start' }); window.scrollBy(0, -60); }, 30); }
}
function partHtml(s, p, i){
  var key = s.id + '-' + i;
  return '<article class="part" id="part-' + key + '" style="' + scStyle(s.id) + '"><div class="part-h"><h3><span>' + s.no + '-' + (i + 1) + '</span>' + esc(p.t) + '</h3><label class="done' + (st.done[key] ? ' checked' : '') + '"><input type="checkbox" data-done="' + key + '"' + (st.done[key] ? ' checked' : '') + '>復習済み</label></div>'
    + p.b.map(function(b){ return '<div class="blk">' + rBlock(b) + '</div>'; }).join('')
    + '<div class="pacts"><button type="button" class="btn sm" data-act="hear" data-id="' + s.id + '" data-p="' + i + '">このパートを聞く</button><button type="button" class="btn sm" data-act="quizpart" data-id="' + s.id + '">' + s.no + 'の小テスト</button></div></article>';
}
function learnBody(){
  if (learnSel === 'map'){
    var doneN = Object.keys(st.done).filter(function(k){ return st.done[k]; }).length, tot = 0; S.forEach(function(s){ tot += s.parts.length; });
    var h = '<div class="card"><b>要点シートの復習済み: ' + doneN + ' / ' + tot + 'パート</b></div>';
    h += '<div class="card"><h2 class="st">紛らわしいペア早見表</h2>' + rCmp(['ペア','違い','台本'], PAIRS) + '</div>';
    h += '<div class="card"><h2 class="st">年号・数字</h2>' + rCmp(['年・数','出来事','台本'], NUMS) + '</div>';
    return h;
  }
  var s = sc(learnSel);
  return '<div class="card" style="border-left:8px solid ' + s.ac + '"><b>' + s.no + ' ' + esc(s.title) + '</b><div class="small muted">' + esc(s.range) + '。' + esc(s.lead) + '</div></div>' + s.parts.map(function(p, i){ return partHtml(s, p, i); }).join('');
}
function learnSearch(q){
  var out = '';
  S.forEach(function(s){ s.parts.forEach(function(p, i){ var html = partHtml(s, p, i), txt = html.replace(/<[^>]+>/g, '').toLowerCase(); if (txt.indexOf(q) >= 0) out += html; }); });
  return out || '<div class="card">一致する用語がありません。別の言葉で検索してください。</div>';
}
function bindLearn(){
  $$('[data-done]').forEach(function(c){ c.addEventListener('change', function(){ st.done[c.dataset.done] = c.checked; c.parentNode.classList.toggle('checked', c.checked); save(); }); });
  $$('[data-act="quizpart"]').forEach(function(b){ b.addEventListener('click', function(){ startQuiz('sc', b.dataset.id); }); });
}

/* ================= 設定 ================= */
function renderSettings(){
  var s = st.settings, el = $('#v-settings');
  var h = '<h1 class="vt">設定</h1><div class="card"><h2 class="st">試験と目標</h2><div class="form">'
    + '<label for="sDate">試験日</label><input type="date" id="sDate" value="' + esc(s.examDate) + '">'
    + '<label for="sTarget">各シナリオを聞く回数の目標</label><select id="sTarget">' + [1,2,3,4,5,6].map(function(n){ return '<option value="' + n + '"' + (s.targetListens === n ? ' selected' : '') + '>' + n + '回</option>'; }).join('') + '</select>'
    + '<label for="sPass">合格ラインの目安(正答率%)</label><input type="number" id="sPass" min="50" max="90" step="1" value="' + s.passLine + '">'
    + '<label for="sMode">表示モード</label><select id="sMode"><option value="auto"' + (s.viewMode === 'auto' ? ' selected' : '') + '>自動(画面の幅で切り替え)</option><option value="pc"' + (s.viewMode === 'pc' ? ' selected' : '') + '>パソコン</option><option value="sp"' + (s.viewMode === 'sp' ? ' selected' : '') + '>スマートフォン</option></select>'
    + '</div><p class="note">初期値の試験日は2027年第1回のオンライン試験(1月16日)。申込期間はJDLAの公式サイトで確認してください。</p></div>';
  h += '<div class="card"><h2 class="st">分野の重み(合格の見込みの計算用)</h2><p class="small muted" style="margin:0">分野ごとの出題割合は公式非公開です。初期値は新シラバスで比重が上がった生成AI・法律倫理を厚めにした仮の値です。</p><div class="wgrid">'
    + SID.map(function(id){ return '<label style="color:' + sc(id).ac + '">' + sc(id).no + '<input type="number" min="0" max="50" step="1" data-w="' + id + '" value="' + s.weights[id] + '" aria-label="' + esc(sc(id).title) + 'の重み"></label>'; }).join('') + '</div></div>';
  h += '<div class="card"><h2 class="st">音声ファイル</h2><div id="fileList" class="small">読み込み中…</div><p class="note" id="quota"></p></div>';
  h += '<div class="card"><h2 class="st">バックアップ</h2><p class="small" style="margin:0 0 8px">進捗・テストの成績・設定をファイルに書き出せます。ブラウザのデータを消すと記録も消えるので、ときどき保存しておくと安心です。音声ファイルは含みません。</p>'
    + '<div class="row"><button type="button" class="btn pri" id="bkSave">ファイルに書き出す</button><button type="button" class="btn" id="bkCopy">コピー</button><button type="button" class="btn" id="bkLoad">ファイルから戻す</button></div>'
    + '<details style="margin-top:10px"><summary class="small">テキストを貼り付けて戻す</summary><textarea id="bkText" placeholder="書き出したテキストを貼り付け" aria-label="バックアップのテキスト"></textarea><button type="button" class="btn sm" id="bkPaste" style="margin-top:6px">貼り付けた内容で戻す</button></details>'
    + '<p class="note">最終書き出し: ' + (st.lastBackup ? new Date(st.lastBackup).toLocaleString('ja-JP') : 'まだありません') + '</p></div>';
  h += '<div class="card"><h2 class="st">リセット</h2><button type="button" class="btn danger" id="resetAll">学習の記録をすべて消す</button><p class="note">音声ファイルは残ります。消す前に書き出しをおすすめします。</p></div>';
  h += '<p class="note">データはこの端末のブラウザの中だけに保存され、外部には送信されません。PCとスマホの間では共有されないので、移すときはバックアップを使ってください。</p>';
  el.innerHTML = h;

  $('#sDate').addEventListener('change', function(e){ s.examDate = e.target.value; save(); renderBar(); toast('試験日を変更しました'); });
  $('#sTarget').addEventListener('change', function(e){ s.targetListens = Number(e.target.value); save(); });
  $('#sPass').addEventListener('change', function(e){ s.passLine = clamp(Number(e.target.value) || 70, 50, 90); e.target.value = s.passLine; save(); });
  $('#sMode').addEventListener('change', function(e){ s.viewMode = e.target.value; save(); applyMode(); });
  $$('[data-w]').forEach(function(x){ x.addEventListener('change', function(){ s.weights[x.dataset.w] = clamp(Number(x.value) || 0, 0, 50); x.value = s.weights[x.dataset.w]; save(); }); });
  $('#bkSave').addEventListener('click', exportFile);
  $('#bkCopy').addEventListener('click', function(){ var t = JSON.stringify(backupObj()); if (navigator.clipboard) navigator.clipboard.writeText(t).then(function(){ toast('コピーしました'); }, function(){ $('#bkText').value = t; toast('コピーできませんでした。下の欄から手動でコピーしてください'); }); });
  $('#bkLoad').addEventListener('click', function(){ $('#backupPick').click(); });
  $('#bkPaste').addEventListener('click', function(){ importText($('#bkText').value); });
  $('#resetAll').addEventListener('click', function(){
    if (!window.confirm('学習の記録(聞いた進捗・テストの成績・推移)をすべて消します。よろしいですか?')) return;
    var keep = st.settings; st = defaults(); st.settings = keep; save(true); toast('記録を消しました'); renderAll();
  });
  renderFileList();
}
function renderFileList(){
  refreshFiles().then(function(){
    var h = SID.map(function(id){ var a = A(id); return '<div class="row" style="justify-content:space-between;border-top:1px solid var(--line);padding:6px 0"><span><b style="color:' + sc(id).ac + '">' + sc(id).no + '</b> ' + (hasFile[id] ? esc(a.name || '登録済み') + (a.dur ? '(' + fmtT(a.dur) + ')' : '') : '<span class="muted">未登録</span>') + '</span>' + (hasFile[id] ? '<button type="button" class="btn sm danger" data-delf="' + id + '">削除</button>' : '<button type="button" class="btn sm" data-addf="' + id + '">選ぶ</button>') + '</div>'; }).join('');
    var fl = $('#fileList'); if (!fl) return; fl.innerHTML = h;
    $$('[data-delf]').forEach(function(b){ b.addEventListener('click', function(){ var id = b.dataset.delf; if (!window.confirm(sc(id).no + ' の音声ファイルを削除しますか?(聞いた回数は残ります)')) return; idb.del(id).then(function(){ hasFile[id] = false; if (cur === id){ au.pause(); au.removeAttribute('src'); } renderSettings(); renderMini(); }); }); });
    $$('[data-addf]').forEach(function(b){ b.addEventListener('click', function(){ cur = b.dataset.addf; $('#filePick').click(); }); });
  });
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(function(q){ var el = $('#quota'); if (el) el.textContent = '使用中 ' + Math.round(q.usage / 1048576) + 'MB / 使える目安 ' + Math.round(q.quota / 1048576) + 'MB'; }).catch(function(){});
}
function backupObj(){ var o = JSON.parse(JSON.stringify(st)); return { app:'gken-mimi', v:1, at:new Date().toISOString(), data:o }; }
function exportFile(){
  var blob = new Blob([JSON.stringify(backupObj(), null, 1)], { type:'application/json' });
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'gken-backup-' + dkey() + '.json';
  document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  st.lastBackup = Date.now(); save(); toast('書き出しました'); renderSettings();
}
function importText(t){
  try {
    var o = JSON.parse(t); if (!o || o.app !== 'gken-mimi' || !o.data) throw new Error('形式が違います');
    if (!window.confirm('今の記録を、' + (o.at ? new Date(o.at).toLocaleString('ja-JP') : '') + ' のバックアップで置き換えます。よろしいですか?')) return;
    st = normalize(o.data); save(true); applyMode(); toast('バックアップから戻しました'); renderAll();
  } catch (e) { toast('読み込めませんでした: ' + (e.message || 'ファイルを確認してください')); }
}
$('#backupPick').addEventListener('change', function(e){ var f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return; f.text().then(importText); });

/* ================= 起動 ================= */
applyMode(); renderBar();
refreshFiles().then(function(){
  var v = location.hash.slice(1); go(VIEWS.indexOf(v) >= 0 ? v : 'home');
  if (cur && hasFile[cur]) loadScenario(cur);
  renderMini();
});
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function(){});
