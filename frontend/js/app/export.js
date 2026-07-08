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
        <h2 id="modal-title">Export Data</h2>
        <button class="modal-close" id="export-modal-close" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <p class="export-modal-desc">Download your collection, sessions, and players in standard formats.</p>
        <label class="export-private-toggle">
          <input type="checkbox" id="export-include-private">
          <span>Include private fields in CSV <span class="export-private-hint">(prices, location, notes, condition)</span></span>
        </label>
        <div class="export-options">
          <button class="export-option-btn" id="export-json-btn">
            <span class="export-option-info">
              <span class="export-option-name">JSON</span>
              <span class="export-option-desc">Full structured data including sessions and players</span>
            </span>
            <svg class="export-option-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M9 18l6-6-6-6"/></svg>
          </button>
          <button class="export-option-btn" id="export-csv-btn">
            <span class="export-option-info">
              <span class="export-option-name">CSV <span class="export-option-tag">Spreadsheet</span></span>
              <span class="export-option-desc">Flat table format for Excel or Google Sheets</span>
            </span>
            <svg class="export-option-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M9 18l6-6-6-6"/></svg>
          </button>
          <button class="export-option-btn" id="export-images-btn">
            <span class="export-option-info">
              <span class="export-option-name">Images <span class="export-option-tag">ZIP</span></span>
              <span class="export-option-desc">All cover images and gallery photos as a ZIP archive</span>
            </span>
            <svg class="export-option-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        </div>
      </div>
    </div>`;
  openModal(inner);
  inner.querySelector('#export-modal-close').addEventListener('click', closeModal);
  inner.querySelector('#export-json-btn').addEventListener('click', () => {
    window.open('/api/games/export/json', '_blank');
    closeModal();
  });
  inner.querySelector('#export-csv-btn').addEventListener('click', () => {
    const includePrivate = inner.querySelector('#export-include-private').checked;
    const url = '/api/games/export/csv' + (includePrivate ? '?include_private=true' : '');
    window.open(url, '_blank');
    closeModal();
  });
  inner.querySelector('#export-images-btn').addEventListener('click', () => {
    window.open('/api/games/export/images', '_blank');
    closeModal();
  });
}
