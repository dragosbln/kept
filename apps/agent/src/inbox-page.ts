// The approval inbox, v0: one page, no framework, served by the agent
// service and talking to /inbox/*. Built the way the widget is so it can
// ship today; a Next.js front can replace it against the same API. No
// template literals inside the page script on purpose: the page is one
// TypeScript template literal.

export const INBOX_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kept · Approval inbox</title>
<style>
  :root { --bg:#f7f7f5; --panel:#fff; --ink:#1c1c1a; --muted:#6b6b66; --line:#e3e3df; --ok:#1f7a3a; --warn:#a15c00; --bad:#a32b2b; --accent:#2b4fa3; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color:var(--ink); background:var(--bg); }
  header { display:flex; align-items:center; gap:16px; padding:12px 20px; background:var(--panel); border-bottom:1px solid var(--line); }
  header h1 { font-size:16px; margin:0; }
  header .actor { margin-left:auto; display:flex; align-items:center; gap:8px; color:var(--muted); }
  header input { padding:6px 8px; border:1px solid var(--line); border-radius:6px; font:inherit; }
  main { display:grid; grid-template-columns: 440px 1fr; gap:16px; padding:16px 20px; }
  section { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:0 0 10px; }
  .row { padding:10px 0; border-top:1px solid var(--line); cursor:pointer; }
  .row:first-of-type { border-top:0; }
  .row.selected { background:#f0f3fa; margin:0 -16px; padding:10px 16px; }
  .row .title { display:flex; justify-content:space-between; font-weight:600; }
  .row .meta { color:var(--muted); font-size:12px; }
  .row .preview { margin-top:4px; color:var(--ink); }
  .empty { color:var(--muted); font-style:italic; }
  .badge { display:inline-block; padding:1px 7px; border-radius:999px; font-size:11px; font-weight:600; border:1px solid currentColor; }
  .badge.pending { color:var(--warn); } .badge.ok { color:var(--ok); } .badge.denied, .badge.failed { color:var(--bad); } .badge.unknown, .badge.attempted { color:var(--accent); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:600; }
  td.num, th.num { text-align:right; font-variant-numeric: tabular-nums; }
  .actions { display:flex; gap:8px; margin:12px 0; }
  button { padding:8px 14px; border-radius:8px; border:1px solid var(--line); background:var(--panel); font:inherit; cursor:pointer; }
  button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  button.danger { color:var(--bad); }
  button:disabled { opacity:.5; cursor:default; }
  .transcript { display:flex; flex-direction:column; gap:8px; max-height:360px; overflow:auto; padding:4px 0; }
  .msg { padding:8px 10px; border-radius:8px; max-width:85%; white-space:pre-wrap; }
  .msg.user { background:#eef1f7; align-self:flex-start; }
  .msg.assistant { background:#f3f3f0; align-self:flex-end; }
  .msg.tool { font:12px ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--muted); background:transparent; border:1px dashed var(--line); align-self:stretch; max-width:100%; }
  .kv { display:grid; grid-template-columns:160px 1fr; gap:4px 12px; font-size:13px; }
  .kv dt { color:var(--muted); } .kv dd { margin:0; word-break:break-all; }
  .flash { padding:8px 10px; border-radius:8px; background:#eef7ef; color:var(--ok); margin-bottom:10px; }
  .flash.bad { background:#fbeeee; color:var(--bad); }
  .stack > * + * { margin-top:14px; }
  .mono { font:12px ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<header>
  <h1>Kept · Approval inbox</h1>
  <span class="muted" id="counts"></span>
  <label class="actor">Acting as <input id="actor" placeholder="your name" size="14"></label>
</header>
<main>
  <div class="stack">
    <section>
      <h2>Pending approval</h2>
      <div id="pending" class="empty">Loading…</div>
    </section>
    <section>
      <h2>Needs reconciliation</h2>
      <div id="reconcile" class="empty">Loading…</div>
    </section>
    <section>
      <h2>Audit trail</h2>
      <div id="audit" class="empty">Nothing yet.</div>
    </section>
  </div>
  <section id="detail"><div class="empty">Select a request.</div></section>
</main>
<script>
(function () {
  var state = { selectedId: null, flash: null };
  var actorInput = document.getElementById('actor');
  try { actorInput.value = localStorage.getItem('kept.actor') || ''; } catch (e) {}
  actorInput.addEventListener('change', function () { try { localStorage.setItem('kept.actor', actorInput.value); } catch (e) {} });

  function actor() { return actorInput.value.trim() || 'human'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }
  function money(minor, currency) { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency }).format(minor / 100); } catch (e) { return minor + ' ' + currency; } }
  function when(ts) { return new Date(ts).toLocaleString(); }
  function badge(status) { return '<span class="badge ' + esc(status) + '">' + esc(status) + '</span>'; }

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'x-kept-actor': actor() };
    if (opts.body) headers['content-type'] = 'application/json';
    return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (res) { return res.json().then(function (json) { return { ok: res.ok, status: res.status, json: json }; }); });
  }

  function rowHtml(item, selected) {
    var r = item.record, c = item.conversation;
    var d = r.decisionRecord;
    return '<div class="row' + (selected ? ' selected' : '') + '" data-id="' + esc(r.id) + '">' +
      '<div class="title"><span>' + esc(r.orderId) + ' · ' + esc(r.orderItemId.replace(r.orderId + '-', '')) + ' × ' + r.quantity + '</span><span>' + money(r.amountMinorUnits, r.currency) + '</span></div>' +
      '<div class="meta">' + badge(r.status) + ' ' + esc(d.outcome) + (d.reason ? ' · ' + esc(d.reason) : '') + ' · ' + esc(when(r.createdAt)) + (c && c.takeOver ? ' · taken over' : '') + '</div>' +
      (c ? '<div class="preview">“' + esc(c.lastCustomerMessage) + '”</div>' : '') +
      '</div>';
  }

  function renderList(elId, items, emptyText) {
    var el = document.getElementById(elId);
    if (!items.length) { el.className = 'empty'; el.textContent = emptyText; return; }
    el.className = '';
    el.innerHTML = items.map(function (it) { return rowHtml(it, it.record.id === state.selectedId); }).join('');
    Array.prototype.forEach.call(el.querySelectorAll('.row'), function (row) {
      row.addEventListener('click', function () { select(row.getAttribute('data-id')); });
    });
  }

  function renderAudit(entries) {
    var el = document.getElementById('audit');
    if (!entries.length) { el.className = 'empty'; el.textContent = 'Nothing yet.'; return; }
    el.className = '';
    el.innerHTML = '<table><tr><th>When</th><th>Actor</th><th>Action</th><th>What</th></tr>' +
      entries.slice().reverse().map(function (e) {
        var what = e.type === 'refund' ? (esc(e.statusBefore) + ' → ' + esc(e.statusAfter) + ' <span class="mono">' + esc(e.recordId.slice(0, 8)) + '</span>') : ('conversation <span class="mono">' + esc(e.conversationId.slice(0, 8)) + '</span>');
        return '<tr><td>' + esc(when(e.createdAt)) + '</td><td>' + esc(e.actor) + '</td><td>' + esc(e.action) + '</td><td>' + what + '</td></tr>';
      }).join('') + '</table>';
  }

  function capsTable(perCap) {
    if (!perCap.length) return '<div class="empty">No caps evaluated.</div>';
    return '<table><tr><th>Cap</th><th class="num">Limit</th><th class="num">Consumed</th><th class="num">Requested</th><th class="num">Remaining before</th><th>Verdict</th></tr>' +
      perCap.map(function (row) {
        return '<tr><td>' + esc(row.kind) + (row.sinceMs ? '<div class="meta">since ' + esc(when(row.sinceMs)) + '</div>' : '') + '</td>' +
          '<td class="num">' + money(row.capAmountMinorUnits, row.currency) + '</td>' +
          '<td class="num">' + money(row.consumedAmountMinorUnits, row.currency) + (row.contributingRecordIds.length ? '<div class="meta">' + row.contributingRecordIds.length + ' prior</div>' : '') + '</td>' +
          '<td class="num">' + money(row.requestedAmountMinorUnits, row.currency) + '</td>' +
          '<td class="num">' + money(row.remainingBeforeMinorUnits, row.currency) + '</td>' +
          '<td>' + badge(row.outcome === 'allow' ? 'ok' : 'pending') + ' ' + esc(row.outcome) + '</td></tr>';
      }).join('') + '</table>';
  }

  function transcript(conv) {
    if (!conv) return '<div class="empty">Conversation not found.</div>';
    var html = conv.messages.map(function (m) {
      return m.parts.map(function (p) {
        if (p.type === 'text') return '<div class="msg ' + esc(m.role) + '">' + esc(p.content) + '</div>';
        if (p.type === 'tool_call') return '<div class="msg tool">→ ' + esc(p.name) + ' ' + esc(JSON.stringify(p.args)) + '</div>';
        if (p.type === 'tool_call_response') return '<div class="msg tool">← ' + esc(p.status) + ': ' + esc(p.response) + '</div>';
        return '';
      }).join('');
    }).join('');
    return '<div class="transcript">' + html + '</div>';
  }

  function renderDetail(detail) {
    var el = document.getElementById('detail');
    if (!detail) { el.innerHTML = '<div class="empty">Select a request.</div>'; return; }
    var r = detail.record, d = r.decisionRecord, conv = detail.conversation;
    var canDecide = r.status === 'pending';
    var canReconcile = r.status === 'unknown' || r.status === 'attempted';
    var takenOver = conv && conv.takeOver;
    el.innerHTML =
      (state.flash ? '<div class="flash' + (state.flash.bad ? ' bad' : '') + '">' + esc(state.flash.text) + '</div>' : '') +
      '<h2>Refund request ' + badge(r.status) + '</h2>' +
      '<dl class="kv">' +
        '<dt>Order</dt><dd>' + esc(r.orderId) + ' · ' + esc(r.orderItemId) + ' × ' + r.quantity + '</dd>' +
        '<dt>Amount</dt><dd>' + money(r.amountMinorUnits, r.currency) + (r.refundedAmountMinorUnits != null ? ' (moved ' + money(r.refundedAmountMinorUnits, r.refundedAmountCurrency || r.currency) + ')' : '') + '</dd>' +
        '<dt>Decision</dt><dd>' + esc(d.outcome) + (d.reason ? ' · ' + esc(d.reason) : '') + '</dd>' +
        '<dt>Requested</dt><dd>' + esc(when(r.createdAt)) + '</dd>' +
        '<dt>Record</dt><dd class="mono">' + esc(r.id) + '</dd>' +
        '<dt>Conversation</dt><dd class="mono">' + esc(r.conversationId) + (takenOver ? ' · taken over by ' + esc(conv.takeOver.actor) : '') + '</dd>' +
        '<dt>Prompt hash</dt><dd class="mono">' + esc(r.promptHash.slice(0, 16)) + '…</dd>' +
        '<dt>Policy config</dt><dd class="mono">' + esc(d.record.configHash.slice(0, 16)) + '…</dd>' +
      '</dl>' +
      '<div class="actions">' +
        '<button class="primary" data-action="approve"' + (canDecide ? '' : ' disabled') + '>Approve and refund</button>' +
        '<button class="danger" data-action="deny"' + (canDecide ? '' : ' disabled') + '>Deny</button>' +
        '<button data-action="reconcile"' + (canReconcile ? '' : ' disabled') + '>Reconcile with backend</button>' +
        '<button data-action="take-over"' + (takenOver || !conv ? ' disabled' : '') + '>Take over conversation</button>' +
      '</div>' +
      '<h2>Caps math</h2>' + capsTable(d.record.perCap) +
      (d.record.eligibility.length ? '<h2 style="margin-top:14px">Eligibility</h2><table>' + d.record.eligibility.map(function (v) { return '<tr><td>' + esc(v.ruleKind) + '</td><td>' + (v.passed ? badge('ok') + ' passed' : badge('denied') + ' ' + esc(v.reason)) + '</td></tr>'; }).join('') + '</table>' : '') +
      '<h2 style="margin-top:14px">Conversation</h2>' + transcript(conv) +
      '<h2 style="margin-top:14px">History for this record</h2>' +
      (detail.auditEntries.length ? '<table>' + detail.auditEntries.map(function (e) { return '<tr><td>' + esc(when(e.createdAt)) + '</td><td>' + esc(e.actor) + '</td><td>' + esc(e.action) + '</td><td>' + esc(e.statusBefore) + ' → ' + esc(e.statusAfter) + '</td></tr>'; }).join('') + '</table>' : '<div class="empty">No human action yet.</div>');
    Array.prototype.forEach.call(el.querySelectorAll('button[data-action]'), function (btn) {
      btn.addEventListener('click', function () { act(btn.getAttribute('data-action'), r, conv); });
    });
  }

  function act(action, record, conv) {
    var path = action === 'take-over'
      ? '/inbox/conversations/' + encodeURIComponent(record.conversationId) + '/take-over'
      : '/inbox/refunds/' + encodeURIComponent(record.id) + '/' + action;
    api(path, { method: 'POST' }).then(function (res) {
      if (res.ok) {
        var text = action === 'take-over' ? 'Conversation taken over.' : (action + ': record is now ' + res.json.record.status + (res.json.execution ? ' (' + res.json.execution.status + ')' : ''));
        state.flash = { text: text, bad: false };
      } else {
        state.flash = { text: 'Refused: ' + (res.json.reason || res.status) + (res.json.ledgerStatus ? ' (record is ' + res.json.ledgerStatus + ')' : ''), bad: true };
      }
      refresh();
    });
  }

  function select(id) { state.selectedId = id; state.flash = null; refresh(); }

  function refresh() {
    Promise.all([
      api('/inbox/refunds/pending'),
      api('/inbox/refunds/needing-reconciliation'),
      api('/inbox/audit'),
      state.selectedId ? api('/inbox/refunds/' + encodeURIComponent(state.selectedId)) : Promise.resolve(null),
    ]).then(function (results) {
      var pending = results[0].json.items, needing = results[1].json.items, audit = results[2].json.entries;
      renderList('pending', pending, 'Nothing waiting for approval.');
      renderList('reconcile', needing, 'Nothing to reconcile.');
      renderAudit(audit);
      document.getElementById('counts').textContent = pending.length + ' pending · ' + needing.length + ' to reconcile';
      renderDetail(results[3] && results[3].ok ? results[3].json : null);
    });
  }

  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>
`;
