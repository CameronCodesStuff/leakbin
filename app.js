import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getFirestore, collection, doc, setDoc, getDoc, query, orderBy, limit, getDocs, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

const FIREBASE_CONFIG = {
};

let db = null, storage = null, firebaseReady = false;
let currentPasteId = null, currentPaste = null;
let allPastes = [], filtered = [];
let sortKey = 'created', sortDir = -1, page = 0;
const PAGE_SIZE = 25;
let pendingFiles = [];
let showingRaw = false;
let dragCounter = 0;

let localPastes = [];
try { localPastes = JSON.parse(localStorage.getItem('leakbin_local') || '[]'); } catch(e) {}
function saveLocal() { try { localStorage.setItem('leakbin_local', JSON.stringify(localPastes.slice(0, 200))); } catch(e) {} }

try {
  if (FIREBASE_CONFIG.apiKey) {
    const app = initializeApp(FIREBASE_CONFIG);
    db = getFirestore(app);
    storage = getStorage(app);
    firebaseReady = true;
    document.getElementById('fb-status').textContent = 'connected';
    document.getElementById('fb-status').style.color = '#cc2200';
  } else throw new Error('no config');
} catch(e) {
  document.getElementById('firebase-bar').style.display = 'block';
}

function genId() { return Array.from({length:8}, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random()*36)]).join(''); }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtSize(n) { if (!n||n<0) return '0b'; if (n<1024) return n+'b'; if (n<1048576) return (n/1024).toFixed(1)+'kb'; return (n/1048576).toFixed(1)+'mb'; }
function timeAgo(ms) { if (!ms) return 'just now'; const s=Math.floor((Date.now()-ms)/1000); if (s<60) return s+'s ago'; if (s<3600) return Math.floor(s/60)+'m ago'; if (s<86400) return Math.floor(s/3600)+'h ago'; if (s<2592000) return Math.floor(s/86400)+'d ago'; return new Date(ms).toLocaleDateString(); }
function extOf(name) { const p=name.lastIndexOf('.'); return p>=0 ? name.slice(p+1).toUpperCase() : 'FILE'; }

function toast(msg, type='') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show ' + (type==='success' ? 'ok' : type==='error' ? 'err' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.className = '', 2800);
}

function setStatus(msg) { document.getElementById('status-msg').textContent = msg; }

function setActive(id) {
  document.querySelectorAll('.sb-item').forEach(el => el.classList.remove('active'));
  if (id) { const el = document.getElementById(id); if (el) el.classList.add('active'); }
}

function hideAll() {
  ['home-panel','new-panel','view-panel'].forEach(id => document.getElementById(id).style.display = 'none');
  document.getElementById('raw-link').style.display = 'none';
}

window.showHome = function() {
  hideAll();
  document.getElementById('home-panel').style.display = 'flex';
  setActive('sb-home');
  history.pushState({}, '', location.pathname);
  loadPastes();
};

window.showNew = function() {
  hideAll();
  document.getElementById('new-panel').style.display = 'flex';
  setActive('sb-new');
  currentPasteId = null;
  history.pushState({}, '', location.pathname);
};

window.applyFilter = function(vis) {
  showHome();
  setTimeout(() => { document.getElementById('filter-vis').value = vis; renderTable(); }, 60);
};

window.onDragOver = function(e) {
  e.preventDefault();
  dragCounter++;
  document.getElementById('drag-overlay').classList.add('active');
};

window.onDragLeave = function(e) {
  dragCounter--;
  if (dragCounter <= 0) { dragCounter = 0; document.getElementById('drag-overlay').classList.remove('active'); }
};

window.onDrop = function(e) {
  e.preventDefault();
  dragCounter = 0;
  document.getElementById('drag-overlay').classList.remove('active');
  addFiles(e.dataTransfer.files);
};

window.addFiles = function(fileList) {
  for (const file of fileList) {
    if (file.size > 15*1024*1024) { toast(file.name + ' exceeds 15MB limit', 'error'); continue; }
    const reader = new FileReader();
    reader.onload = e => {
      pendingFiles.push({ file, dataUrl: e.target.result, name: file.name, size: file.size, mime: file.type || '' });
      renderFileStrip();
    };
    reader.readAsDataURL(file);
  }
};

function renderFileStrip() {
  const strip = document.getElementById('attach-strip');
  const row = document.getElementById('attach-row');
  document.getElementById('st-files').textContent = pendingFiles.length;
  if (pendingFiles.length === 0) { strip.style.display = 'none'; return; }
  strip.style.display = 'flex';
  const cards = pendingFiles.map((f, i) => {
    let thumb = '';
    if (f.mime.startsWith('image/')) thumb = `<img src="${f.dataUrl}" alt="">`;
    else if (f.mime.startsWith('video/')) thumb = `<video src="${f.dataUrl}"></video>`;
    else thumb = `<span class="file-ext">${extOf(f.name)}</span>`;
    return `<div class="file-card">
      <div class="file-thumb">${thumb}</div>
      <div class="file-card-name" title="${escHtml(f.name)}">${escHtml(f.name)}</div>
      <div class="file-card-size">${fmtSize(f.size)}</div>
      <button class="file-remove" onclick="removeFile(${i})">✕</button>
    </div>`;
  }).join('');
  row.innerHTML = cards + `<div id="drop-here-card" onclick="document.getElementById('file-input').click()"><div class="plus">+</div><div>add files</div></div>`;
}

window.removeFile = function(i) { pendingFiles.splice(i, 1); renderFileStrip(); };

window.clearEditor = function() {
  document.getElementById('editor').value = '';
  document.getElementById('paste-title-input').value = '';
  pendingFiles = [];
  renderFileStrip();
  updateLineNums(1);
  document.getElementById('st-chars').textContent = '0';
  document.getElementById('st-files').textContent = '0';
  document.getElementById('url-bar').style.display = 'none';
};

window.submitPaste = async function() {
  const title = document.getElementById('paste-title-input').value.trim() || 'untitled';
  const visibility = document.getElementById('visibility-select').value;
  const expiry = parseInt(document.getElementById('expiry-select').value);
  const mode = document.getElementById('mode-select').value;
  const content = document.getElementById('editor').value;
  const now = Date.now();
  const id = genId();

  if (!content.trim() && pendingFiles.length === 0) { toast('nothing to paste', 'error'); return; }

  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'saving...';

  let paste = { id, title, visibility, content, mode, created: now, expires: expiry > 0 ? now + expiry * 1000 : 0, attachments: [] };

  if (pendingFiles.length > 0) {
    if (firebaseReady && storage) {
      try {
        const uploads = await Promise.all(pendingFiles.map(async f => {
          const r = ref(storage, `pastes/${id}/${f.name}`);
          await uploadBytes(r, f.file);
          const url = await getDownloadURL(r);
          return { name: f.name, size: f.size, mime: f.mime, url };
        }));
        paste.attachments = uploads;
        setStatus('uploaded to firebase');
      } catch(e) {
        paste.attachments = pendingFiles.map(f => ({ name: f.name, size: f.size, mime: f.mime, dataUrl: f.dataUrl }));
        setStatus('storage error — saved locally');
      }
    } else {
      paste.attachments = pendingFiles.map(f => ({ name: f.name, size: f.size, mime: f.mime, dataUrl: f.dataUrl }));
      setStatus('saved locally');
    }
  }

  paste.size = (content?.length || 0) + paste.attachments.reduce((a, f) => a + (f.size || 0), 0);

  if (firebaseReady) {
    try {
      const fb = { ...paste, created: serverTimestamp() };
      fb.attachments = fb.attachments.map(a => ({ name: a.name, size: a.size, mime: a.mime, url: a.url || null }));
      await setDoc(doc(db, 'pastes', id), fb);
    } catch(e) { localPastes.unshift(paste); saveLocal(); }
  } else { localPastes.unshift(paste); saveLocal(); }

  btn.disabled = false;
  btn.textContent = 'submit';
  currentPasteId = id;
  const url = location.origin + location.pathname + '?p=' + id;
  const bar = document.getElementById('url-bar');
  bar.style.display = 'flex';
  document.getElementById('url-bar-text').textContent = url;
  history.pushState({ id }, '', '?p=' + id);
  toast('paste created', 'success');
  pendingFiles = [];
  renderFileStrip();
  viewPaste(id);
  loadFeed();
};

window.viewPaste = async function(id) {
  let paste = null;
  if (firebaseReady) {
    try { const s = await getDoc(doc(db, 'pastes', id)); if (s.exists()) paste = s.data(); } catch(e) {}
  }
  if (!paste) paste = localPastes.find(p => p.id === id);
  if (!paste) { toast('paste not found', 'error'); showHome(); return; }

  const createdMs = paste.created?.seconds ? paste.created.seconds * 1000 : paste.created;
  if (paste.expires && paste.expires > 0 && Date.now() > paste.expires) { toast('paste expired', 'error'); showHome(); return; }

  currentPasteId = id;
  currentPaste = paste;
  showingRaw = false;
  hideAll();
  document.getElementById('view-panel').style.display = 'flex';
  setActive('');

  document.getElementById('view-title').textContent = paste.title || 'untitled';
  const attCount = paste.attachments?.length || 0;
  const hasText = !!(paste.content && paste.content.trim());
  const parts = [];
  if (hasText) parts.push(paste.mode === 'markdown' ? 'markdown' : 'text');
  if (attCount) parts.push(attCount + ' file' + (attCount !== 1 ? 's' : ''));
  document.getElementById('view-meta').textContent = `${timeAgo(createdMs)} · ${parts.join(' + ')} · ${fmtSize(paste.size || paste.content?.length || 0)} · ${paste.visibility}`;

  document.getElementById('md-render').style.display = 'none';
  document.getElementById('view-text-wrap').style.display = 'none';
  document.getElementById('view-attachments').style.display = 'none';

  const isMarkdown = paste.mode === 'markdown';
  document.getElementById('btn-raw-toggle').style.display = isMarkdown && hasText ? '' : 'none';
  document.getElementById('btn-raw-toggle').textContent = 'raw';

  if (hasText) {
    if (isMarkdown) {
      document.getElementById('md-render').style.display = 'block';
      document.getElementById('md-render').innerHTML = parseMarkdown(paste.content);
    } else {
      showViewText(paste.content);
    }
    document.getElementById('raw-link').style.display = 'inline';
    document.getElementById('raw-link').href = location.pathname + '?p=' + id + '&raw=1';
  }

  if (attCount) {
    const wrap = document.getElementById('view-attachments');
    wrap.style.display = 'flex';
    wrap.innerHTML = (paste.attachments || []).map(a => {
      const src = a.url || a.dataUrl || '';
      let body = '';
      if (a.mime && a.mime.startsWith('image/')) body = `<img class="va-img" src="${escHtml(src)}" alt="${escHtml(a.name)}" loading="lazy">`;
      else if (a.mime && a.mime.startsWith('video/')) body = `<video class="va-video" src="${escHtml(src)}" controls></video>`;
      else if (a.mime && a.mime.startsWith('audio/')) body = `<audio class="va-audio" src="${escHtml(src)}" controls></audio>`;
      else body = `<div class="va-file-row"><span class="va-ext">[${extOf(a.name)}]</span><span>${escHtml(a.name)} — ${fmtSize(a.size)}</span>${src ? `<a href="${escHtml(src)}" download="${escHtml(a.name)}" class="tb-btn" style="margin-left:auto">download</a>` : ''}</div>`;
      return `<div class="va-item"><div class="va-label"><span>${escHtml(a.name)}</span><span>${fmtSize(a.size)}</span></div>${body}</div>`;
    }).join('');
  }

  history.pushState({ id }, '', '?p=' + id);
  document.getElementById('url-bar').style.display = 'flex';
  document.getElementById('url-bar-text').textContent = location.origin + location.pathname + '?p=' + id;
};

function showViewText(content) {
  const lines = content.split('\n').length;
  const wrap = document.getElementById('view-text-wrap');
  wrap.style.display = 'flex';
  wrap.innerHTML = `<div id="view-line-nums">${Array.from({length:lines}, (_, i) => i+1).join('\n')}</div><div id="view-code"></div>`;
  wrap.querySelector('#view-code').textContent = content;
}

window.toggleRaw = function() {
  if (!currentPaste?.content) return;
  showingRaw = !showingRaw;
  document.getElementById('btn-raw-toggle').textContent = showingRaw ? 'rendered' : 'raw';
  document.getElementById('md-render').style.display = showingRaw ? 'none' : 'block';
  document.getElementById('view-text-wrap').style.display = showingRaw ? 'flex' : 'none';
  if (showingRaw && !document.getElementById('view-text-wrap').innerHTML) {
    showViewText(currentPaste.content);
    document.getElementById('md-render').style.display = 'none';
  }
};

window.clonePaste = function() {
  if (!currentPaste) return;
  showNew();
  document.getElementById('editor').value = currentPaste.content || '';
  document.getElementById('paste-title-input').value = 'clone of ' + (currentPaste.title || 'untitled');
  document.getElementById('mode-select').value = currentPaste.mode || 'text';
  updateLineNums((currentPaste.content || '').split('\n').length);
};

window.copyUrl = function() {
  if (!currentPasteId) return;
  navigator.clipboard.writeText(location.origin + location.pathname + '?p=' + currentPasteId).then(() => toast('link copied', 'success'));
};

function parseMarkdown(md) {
  let h = escHtml(md);
  h = h.replace(/```([a-z]*)\n?([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code}</code></pre>`);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  h = h.replace(/^[-*]{3,}$/gm, '<hr>');
  h = h.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  h = h.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  h = h.replace(/~~(.+?)~~/g, '<del>$1</del>');
  h = h.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%">');
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  h = h.replace(/(^[*-] .+(\n[*-] .+)*)/gm, m => '<ul>' + m.replace(/^[*-] (.+)$/gm, '<li>$1</li>') + '</ul>');
  h = h.replace(/(^\d+\. .+(\n\d+\. .+)*)/gm, m => '<ol>' + m.replace(/^\d+\. (.+)$/gm, '<li>$1</li>') + '</ol>');
  h = h.replace(/\n{2,}/g, '</p><p>');
  h = '<p>' + h + '</p>';
  h = h.replace(/<p>(<(?:h[1-4]|ul|ol|pre|blockquote|hr)[^>]*>)/g, '$1');
  h = h.replace(/(<\/(?:h[1-4]|ul|ol|pre|blockquote)>)<\/p>/g, '$1');
  h = h.replace(/<p>\s*<\/p>/g, '');
  return h;
}

window.loadPastes = async function() {
  let pastes = [];
  if (firebaseReady) {
    try {
      const q = query(collection(db, 'pastes'), orderBy('created', 'desc'), limit(200));
      const snap = await getDocs(q);
      pastes = snap.docs.map(d => d.data());
    } catch(e) { pastes = [...localPastes]; }
  } else { pastes = [...localPastes]; }
  allPastes = pastes;
  page = 0;
  renderTable();
  loadFeed();
};

window.onSearch = function() { page = 0; renderTable(); };

window.sortBy = function(key) {
  if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = -1; }
  document.querySelectorAll('#paste-table thead th').forEach(th => {
    th.classList.remove('sorted');
    th.textContent = th.textContent.replace(/ [↑↓]$/, '');
  });
  const map = { title:'th-title', attachments:'th-att', visibility:'th-vis', size:'th-size', created:'th-created' };
  const th = document.getElementById(map[key]);
  if (th) { th.classList.add('sorted'); th.textContent = th.textContent + (sortDir > 0 ? ' ↑' : ' ↓'); }
  renderTable();
};

window.prevPage = function() { if (page > 0) { page--; renderTable(); } };
window.nextPage = function() { if ((page+1)*PAGE_SIZE < filtered.length) { page++; renderTable(); } };

function renderTable() {
  const search = document.getElementById('home-search').value.toLowerCase();
  const visFil = document.getElementById('filter-vis').value;

  filtered = allPastes.filter(p => {
    if (p.expires && p.expires > 0 && Date.now() > p.expires) return false;
    if (search && !(p.title || 'untitled').toLowerCase().includes(search)) return false;
    if (visFil !== 'all' && p.visibility !== visFil) return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (sortKey === 'title') return sortDir * (a.title || 'untitled').localeCompare(b.title || 'untitled');
    if (sortKey === 'attachments') return sortDir * ((a.attachments?.length||0) - (b.attachments?.length||0));
    if (sortKey === 'visibility') return sortDir * (a.visibility||'').localeCompare(b.visibility||'');
    if (sortKey === 'size') return sortDir * ((a.size||0) - (b.size||0));
    if (sortKey === 'created') {
      const am = a.created?.seconds ? a.created.seconds*1000 : a.created||0;
      const bm = b.created?.seconds ? b.created.seconds*1000 : b.created||0;
      return sortDir * (am - bm);
    }
    return 0;
  });

  const total = filtered.length;
  const slice = filtered.slice(page*PAGE_SIZE, page*PAGE_SIZE + PAGE_SIZE);
  const tbody = document.getElementById('paste-tbody');
  const empty = document.getElementById('home-empty');

  if (slice.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'flex';
    document.getElementById('paste-table').style.display = 'none';
  } else {
    empty.style.display = 'none';
    document.getElementById('paste-table').style.display = 'table';
    tbody.innerHTML = slice.map(p => {
      const ms = p.created?.seconds ? p.created.seconds*1000 : p.created||0;
      const attCount = p.attachments?.length || 0;
      const attBadge = attCount ? `<span class="tag">${attCount} file${attCount!==1?'s':''}</span>` : '<span style="color:var(--text3);font-size:11px">—</span>';
      const modeBadge = p.mode === 'markdown' ? `<span class="tag" style="color:#885500;border-color:#2a1a00">md</span> ` : '';
      return `<tr onclick="viewPaste('${p.id}')">
        <td class="td-title">${modeBadge}<a href="?p=${p.id}" onclick="event.preventDefault()">${escHtml(p.title||'untitled')}</a></td>
        <td>${attBadge}</td>
        <td class="td-dim">${p.visibility}</td>
        <td class="td-num">${fmtSize(p.size||p.content?.length||0)}</td>
        <td class="td-dim">${timeAgo(ms)}</td>
        <td><button class="tb-btn" style="font-size:10px;padding:2px 8px" onclick="event.stopPropagation();cpUrl('${p.id}')">link</button></td>
      </tr>`;
    }).join('');
  }

  const tp = Math.ceil(total/PAGE_SIZE) || 1;
  document.getElementById('page-info').textContent = `page ${page+1} of ${tp} · ${total} paste${total===1?'':'s'}`;
  document.getElementById('btn-prev').disabled = page === 0;
  document.getElementById('btn-next').disabled = (page+1)*PAGE_SIZE >= total;
  document.getElementById('home-stats-right').textContent = allPastes.length + ' total';
}

window.cpUrl = function(id) {
  navigator.clipboard.writeText(location.origin + location.pathname + '?p=' + id).then(() => toast('link copied', 'success'));
};

async function loadFeed() {
  const feedList = document.getElementById('feed-list');
  const recent = allPastes.slice(0, 14);
  if (!recent.length) { feedList.innerHTML = '<div style="padding:12px;color:var(--text3);font-size:11px">no pastes yet</div>'; return; }
  feedList.innerHTML = recent.map(p => {
    const ms = p.created?.seconds ? p.created.seconds*1000 : p.created||0;
    const attCount = p.attachments?.length || 0;
    const extras = [];
    if (p.mode === 'markdown') extras.push('md');
    if (attCount) extras.push(attCount + ' file' + (attCount!==1?'s':''));
    return `<div class="feed-item" onclick="viewPaste('${p.id}')">
      <div class="fi-title">${escHtml(p.title||'untitled')}</div>
      <div class="fi-meta">${extras.map(e => `<span class="tag">${e}</span>`).join('')} ${timeAgo(ms)}</div>
    </div>`;
  }).join('');
}

const editor = document.getElementById('editor');
const lineNums = document.getElementById('line-nums');

window.updateLineNums = function(count) {
  lineNums.textContent = Array.from({length: Math.max(count, 1)}, (_, i) => i+1).join('\n');
};

editor.addEventListener('input', () => {
  const lines = (editor.value.match(/\n/g) || []).length + 1;
  document.getElementById('st-chars').textContent = editor.value.length;
  updateLineNums(lines);
});

editor.addEventListener('keyup', () => {
  const pos = editor.selectionStart, before = editor.value.substring(0, pos);
  document.getElementById('st-ln').textContent = before.split('\n').length;
  document.getElementById('st-col').textContent = pos - before.lastIndexOf('\n');
});

editor.addEventListener('scroll', () => { lineNums.scrollTop = editor.scrollTop; });

editor.addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = editor.selectionStart;
    editor.value = editor.value.substring(0, s) + '  ' + editor.value.substring(s);
    editor.selectionStart = editor.selectionEnd = s + 2;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); window.submitPaste(); }
});

window.addEventListener('popstate', () => {
  const p = new URLSearchParams(location.search).get('p');
  if (p) viewPaste(p); else showHome();
});

const initParams = new URLSearchParams(location.search);
const initId = initParams.get('p');
const initRaw = initParams.get('raw');

if (initId && initRaw) {
  (async () => {
    let paste = null;
    if (firebaseReady) { try { const s = await getDoc(doc(db, 'pastes', initId)); if (s.exists()) paste = s.data(); } catch(e) {} }
    if (!paste) paste = localPastes.find(p => p.id === initId);
    if (paste?.content) {
      document.body.innerHTML = '<pre style="background:#0a0606;color:#c8b8b8;padding:16px;font-family:Courier New,monospace;font-size:13px;min-height:100vh;white-space:pre-wrap;word-break:break-all">' + escHtml(paste.content) + '</pre>';
    }
  })();
} else if (initId) {
  viewPaste(initId);
} else {
  showHome();
}
