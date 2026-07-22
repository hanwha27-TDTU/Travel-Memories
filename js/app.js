// app.js — Travel Memories UI logic
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // In-memory state
  let memories = [];
  let activeTag = null;
  let searchTerm = '';
  const objectUrls = []; // track for revocation

  // Leaflet map instances
  let browseMap = null;
  let browseLayer = null;
  let pickMap = null;
  let pickMarker = null;
  let detailMap = null;

  // Photos being edited: {existingIds:[], newBlobs:[{id, blob, url}]}
  let editPhotos = { existingIds: [], newFiles: [] };

  // ---- helpers -------------------------------------------------------------
  function trackUrl(blob) {
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    return url;
  }
  function revokeAll() {
    while (objectUrls.length) URL.revokeObjectURL(objectUrls.pop());
  }
  function starString(n) {
    return '★'.repeat(n) + '☆'.repeat(5 - n);
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  // ---- rendering: timeline -------------------------------------------------
  async function loadMemories() {
    memories = await TMDB.listMemories();
    renderTagFilter();
    await renderTimeline();
    renderBrowseMap();
  }

  function filteredMemories() {
    const term = searchTerm.trim().toLowerCase();
    return memories.filter((m) => {
      if (activeTag && !m.tags.includes(activeTag)) return false;
      if (!term) return true;
      const hay = [m.title, m.place, m.memo, ...(m.tags || [])].join(' ').toLowerCase();
      return hay.includes(term);
    });
  }

  function renderTagFilter() {
    const counts = {};
    memories.forEach((m) => (m.tags || []).forEach((t) => (counts[t] = (counts[t] || 0) + 1)));
    const tags = Object.keys(counts).sort();
    const container = $('#tag-filter');
    container.innerHTML = '';
    tags.forEach((t) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip' + (activeTag === t ? ' active' : '');
      chip.textContent = `#${t} (${counts[t]})`;
      chip.addEventListener('click', () => {
        activeTag = activeTag === t ? null : t;
        renderTagFilter();
        renderTimeline();
      });
      container.appendChild(chip);
    });
  }

  async function renderTimeline() {
    const list = filteredMemories();
    const container = $('#timeline');
    container.innerHTML = '';

    $('#empty').classList.toggle('hidden', memories.length !== 0);
    if (memories.length === 0) return;

    for (const m of list) {
      const card = document.createElement('div');
      card.className = 'card';
      card.addEventListener('click', () => openDetail(m.id));

      // thumbnail
      let thumbHtml;
      if (m.photoIds && m.photoIds.length) {
        const blob = await TMDB.getPhoto(m.photoIds[0]);
        thumbHtml = blob
          ? `<img class="card-thumb" src="${trackUrl(blob)}" alt="" />`
          : `<div class="card-thumb placeholder">📷</div>`;
      } else {
        thumbHtml = `<div class="card-thumb placeholder">🧳</div>`;
      }

      const tagsHtml = (m.tags || [])
        .map((t) => `<span class="mini-tag">#${escapeHtml(t)}</span>`)
        .join('');

      card.innerHTML = `
        ${thumbHtml}
        <div class="card-body">
          <p class="card-title">${escapeHtml(m.title || '(제목 없음)')}</p>
          <div class="card-meta">
            <span>🗓️ ${fmtDate(m.date)}</span>
            ${m.place ? `<span>📍 ${escapeHtml(m.place)}</span>` : ''}
            ${m.rating ? `<span class="stars">${starString(m.rating)}</span>` : ''}
          </div>
          ${m.memo ? `<p class="card-memo">${escapeHtml(m.memo)}</p>` : ''}
          ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ''}
        </div>`;
      container.appendChild(card);
    }
  }

  // ---- rendering: browse map ----------------------------------------------
  function mapAvailable() {
    return typeof L !== 'undefined';
  }

  function ensureBrowseMap() {
    if (browseMap) return;
    if (!mapAvailable()) {
      $('#map').innerHTML =
        '<div class="empty">지도를 불러오려면 인터넷 연결이 필요해요.<br>' +
        '기록은 오프라인에서도 저장됩니다.</div>';
      return;
    }
    browseMap = L.map('map').setView([36.5, 127.8], 6); // Korea-ish default
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19,
    }).addTo(browseMap);
    browseLayer = L.layerGroup().addTo(browseMap);
  }

  function renderBrowseMap() {
    if (!browseMap) return; // only render once map view has been opened
    browseLayer.clearLayers();
    const pts = memories.filter((m) => m.lat != null && m.lng != null);
    const bounds = [];
    pts.forEach((m) => {
      const marker = L.marker([m.lat, m.lng]).addTo(browseLayer);
      marker.bindPopup(
        `<strong>${escapeHtml(m.title || '')}</strong><br>${fmtDate(m.date)}` +
          (m.place ? `<br>📍 ${escapeHtml(m.place)}` : '')
      );
      marker.on('click', () => {}); // popup handles it
      bounds.push([m.lat, m.lng]);
    });
    if (bounds.length) browseMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
  }

  // ---- tabs ----------------------------------------------------------------
  function switchView(view) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    $$('.view').forEach((v) => v.classList.remove('active'));
    $(`#view-${view}`).classList.add('active');
    if (view === 'map') {
      ensureBrowseMap();
      if (browseMap) {
        setTimeout(() => {
          browseMap.invalidateSize();
          renderBrowseMap();
        }, 50);
      }
    }
  }

  // ---- modal: add / edit ---------------------------------------------------
  function openForm(memory) {
    const isEdit = !!memory;
    $('#modal-title').textContent = isEdit ? '여행 기록 편집' : '새 여행 기록';
    $('#f-id').value = isEdit ? memory.id : '';
    $('#f-title').value = isEdit ? memory.title : '';
    $('#f-date').value = isEdit ? memory.date : new Date().toISOString().slice(0, 10);
    $('#f-place').value = isEdit ? memory.place : '';
    $('#f-memo').value = isEdit ? memory.memo : '';
    $('#f-tags').value = isEdit ? (memory.tags || []).join(', ') : '';
    setRating(isEdit ? memory.rating : 0);

    editPhotos = { existingIds: isEdit ? [...(memory.photoIds || [])] : [], newFiles: [] };
    $('#f-photos').value = '';

    // coords
    const lat = isEdit ? memory.lat : null;
    const lng = isEdit ? memory.lng : null;
    setCoords(lat, lng);

    $('#f-delete').classList.toggle('hidden', !isEdit);

    $('#modal').classList.remove('hidden');
    setTimeout(() => initPickMap(lat, lng), 50);
    renderPhotoPreview();
  }

  function closeForm() {
    $('#modal').classList.add('hidden');
  }

  // rating widget
  function setRating(n) {
    const el = $('#f-rating');
    el.dataset.value = n;
    $$('#f-rating span').forEach((s) => {
      s.textContent = Number(s.dataset.star) <= n ? '★' : '☆';
    });
  }

  // coords
  let curLat = null, curLng = null;
  function setCoords(lat, lng) {
    curLat = lat;
    curLng = lng;
    $('#f-coords').textContent =
      lat != null && lng != null ? `📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}` : '위치 미지정';
  }

  function initPickMap(lat, lng) {
    if (!mapAvailable()) {
      $('#pick-map').innerHTML =
        '<div class="empty" style="padding:24px">지도는 온라인에서만 표시돼요.<br>장소명만 입력해도 저장됩니다.</div>';
      return;
    }
    if (!pickMap) {
      pickMap = L.map('pick-map').setView([lat ?? 36.5, lng ?? 127.8], lat != null ? 12 : 6);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 19,
      }).addTo(pickMap);
      pickMap.on('click', (e) => {
        setCoords(e.latlng.lat, e.latlng.lng);
        placePickMarker(e.latlng.lat, e.latlng.lng);
      });
    }
    pickMap.invalidateSize();
    if (lat != null && lng != null) {
      placePickMarker(lat, lng);
      pickMap.setView([lat, lng], 12);
    } else if (pickMarker) {
      pickMap.removeLayer(pickMarker);
      pickMarker = null;
    }
  }

  function placePickMarker(lat, lng) {
    if (pickMarker) pickMarker.setLatLng([lat, lng]);
    else pickMarker = L.marker([lat, lng]).addTo(pickMap);
  }

  // photo preview (existing + new)
  async function renderPhotoPreview() {
    const container = $('#photo-preview');
    container.innerHTML = '';

    for (const pid of editPhotos.existingIds) {
      const blob = await TMDB.getPhoto(pid);
      if (!blob) continue;
      container.appendChild(makeThumb(trackUrl(blob), () => {
        editPhotos.existingIds = editPhotos.existingIds.filter((x) => x !== pid);
        renderPhotoPreview();
      }));
    }
    editPhotos.newFiles.forEach((file, i) => {
      container.appendChild(makeThumb(trackUrl(file), () => {
        editPhotos.newFiles.splice(i, 1);
        renderPhotoPreview();
      }));
    });
  }

  function makeThumb(url, onDelete) {
    const wrap = document.createElement('div');
    wrap.className = 'thumb-wrap';
    const img = document.createElement('img');
    img.src = url;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'thumb-del';
    del.textContent = '✕';
    del.addEventListener('click', onDelete);
    wrap.appendChild(img);
    wrap.appendChild(del);
    return wrap;
  }

  // ---- save ----------------------------------------------------------------
  async function handleSubmit(e) {
    e.preventDefault();
    const id = $('#f-id').value || null;

    const tags = $('#f-tags').value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    // Save new photos first, collect ids
    const newPhotoIds = [];
    const memId = id || TMDB.uuid();
    for (const file of editPhotos.newFiles) {
      const pid = await TMDB.savePhoto(memId, file);
      newPhotoIds.push(pid);
    }

    const record = {
      id: memId,
      title: $('#f-title').value.trim(),
      date: $('#f-date').value,
      place: $('#f-place').value.trim(),
      lat: curLat,
      lng: curLng,
      memo: $('#f-memo').value.trim(),
      rating: Number($('#f-rating').dataset.value) || 0,
      tags,
      photoIds: [...editPhotos.existingIds, ...newPhotoIds],
    };

    if (id) {
      const existing = await TMDB.getMemory(id);
      if (existing) {
        record.createdAt = existing.createdAt;
        // clean up removed photos
        const removed = (existing.photoIds || []).filter((p) => !record.photoIds.includes(p));
        for (const p of removed) await TMDB.deletePhoto(p);
      }
    }

    await TMDB.saveMemory(record);
    closeForm();
    revokeAll();
    await loadMemories();
  }

  async function handleDelete() {
    const id = $('#f-id').value;
    if (!id) return;
    if (!confirm('이 기록을 삭제할까요?')) return;
    await TMDB.deleteMemory(id);
    closeForm();
    await loadMemories();
  }

  // ---- detail --------------------------------------------------------------
  async function openDetail(id) {
    const m = await TMDB.getMemory(id);
    if (!m) return;
    $('#detail-title').textContent = m.title || '(제목 없음)';

    const body = $('#detail-body');
    body.innerHTML = '';

    // photos
    if (m.photoIds && m.photoIds.length) {
      const photos = document.createElement('div');
      photos.className = 'detail-photos';
      for (const pid of m.photoIds) {
        const blob = await TMDB.getPhoto(pid);
        if (!blob) continue;
        const img = document.createElement('img');
        img.src = trackUrl(blob);
        photos.appendChild(img);
      }
      body.appendChild(photos);
    }

    const meta = document.createElement('div');
    meta.className = 'detail-meta';
    meta.innerHTML =
      `<span>🗓️ ${fmtDate(m.date)}</span>` +
      (m.place ? `<span>📍 ${escapeHtml(m.place)}</span>` : '') +
      (m.rating ? `<span class="stars">${starString(m.rating)}</span>` : '');
    body.appendChild(meta);

    if (m.tags && m.tags.length) {
      const tags = document.createElement('div');
      tags.className = 'card-tags';
      tags.innerHTML = m.tags.map((t) => `<span class="mini-tag">#${escapeHtml(t)}</span>`).join('');
      body.appendChild(tags);
    }

    if (m.memo) {
      const memo = document.createElement('p');
      memo.className = 'detail-memo';
      memo.textContent = m.memo;
      body.appendChild(memo);
    }

    if (m.lat != null && m.lng != null && mapAvailable()) {
      const mapDiv = document.createElement('div');
      mapDiv.id = 'detail-map';
      body.appendChild(mapDiv);
      setTimeout(() => {
        if (detailMap) { detailMap.remove(); detailMap = null; }
        detailMap = L.map('detail-map').setView([m.lat, m.lng], 12);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap', maxZoom: 19,
        }).addTo(detailMap);
        L.marker([m.lat, m.lng]).addTo(detailMap);
        detailMap.invalidateSize();
      }, 60);
    }

    $('#detail-edit').onclick = () => {
      closeDetail();
      openForm(m);
    };
    $('#detail').classList.remove('hidden');
  }

  function closeDetail() {
    $('#detail').classList.add('hidden');
    if (detailMap) { detailMap.remove(); detailMap = null; }
  }

  // ---- events --------------------------------------------------------------
  function bind() {
    $('#btn-add').addEventListener('click', () => openForm(null));
    $('#modal-close').addEventListener('click', closeForm);
    $('#detail-close').addEventListener('click', closeDetail);
    $('#memory-form').addEventListener('submit', handleSubmit);
    $('#f-delete').addEventListener('click', handleDelete);

    // close modal on backdrop click
    $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeForm(); });
    $('#detail').addEventListener('click', (e) => { if (e.target.id === 'detail') closeDetail(); });

    // rating clicks
    $('#f-rating').addEventListener('click', (e) => {
      const star = e.target.dataset.star;
      if (star) setRating(Number(star));
    });

    // tabs
    $$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

    // search
    $('#search').addEventListener('input', (e) => {
      searchTerm = e.target.value;
      renderTimeline();
    });

    // photo input
    $('#f-photos').addEventListener('change', (e) => {
      for (const file of e.target.files) editPhotos.newFiles.push(file);
      e.target.value = '';
      renderPhotoPreview();
    });

    // geolocation
    $('#f-locate').addEventListener('click', () => {
      if (!navigator.geolocation) { alert('이 브라우저는 위치를 지원하지 않아요.'); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          setCoords(latitude, longitude);
          if (pickMap) { placePickMarker(latitude, longitude); pickMap.setView([latitude, longitude], 13); }
        },
        () => alert('위치를 가져오지 못했어요.')
      );
    });
  }

  // ---- init ----------------------------------------------------------------
  bind();
  loadMemories();
})();
