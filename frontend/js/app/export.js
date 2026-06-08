/**
 * Export modal, extracted from app.js.
 */
export function bindExportModal() {
  const btn = document.getElementById('export-btn');
  if (!btn) return;
  btn.addEventListener('click', openExportModal);
}

export function openExportModal() {
  const inner = document.createElement('div');
  inner.innerHTML = `
    <div class="modal-content-panel">
      <div class="modal-panel-header">
        <h2>Export Data</h2>
        <button class="modal-close" id="export-modal-close" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <p style="color:var(--text-2);font-size:0.85rem;margin-bottom:12px">Download your collection, sessions, and players in standard formats.</p>
        <div class="form-group" style="margin-bottom:10px">
          <button class="btn btn-secondary" id="export-json-btn" style="width:100%">Export as JSON</button>
        </div>
        <div class="form-group" style="margin-bottom:10px">
          <button class="btn btn-secondary" id="export-csv-btn" style="width:100%">Export as CSV</button>
        </div>
        <div class="form-group">
          <button class="btn btn-secondary" id="export-images-btn" style="width:100%">Export Images (ZIP)</button>
        </div>
      </div>
    </div>`;
  openModal(inner);
  inner.querySelector('#export-modal-close').addEventListener('click', closeModal);
  inner.querySelector('#export-json-btn').addEventListener('click', () => {
    window.open('/api/games/export/json', '_blank');
  });
  inner.querySelector('#export-csv-btn').addEventListener('click', () => {
    window.open('/api/games/export/csv', '_blank');
  });
  inner.querySelector('#export-images-btn').addEventListener('click', () => {
    window.open('/api/games/export/images', '_blank');
  });
}
