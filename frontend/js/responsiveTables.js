// Tables become stacked cards on narrow screens (see the max-width block at
// the end of sahara.css). That CSS labels each cell with the text of its
// column header, taken from a data-label attribute -- this keeps the
// attribute in sync for every <table> and .grid-table on the page,
// including ones whose rows are re-rendered later by the page's own script.

function labelTable(table) {
  const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  table.querySelectorAll('tbody tr').forEach((row) => {
    [...row.children].forEach((cell, i) => {
      if (cell.colSpan > 1) return;
      if (headers[i]) cell.dataset.label = headers[i];
    });
  });
}

function labelGrid(grid) {
  const headers = [...grid.querySelectorAll('.grid-header .grid-cell')].map((cell) => {
    // The drag handle is an icon-font ligature; its text must not leak into the label.
    const clone = cell.cloneNode(true);
    clone.querySelectorAll('.col-grip').forEach((grip) => grip.remove());
    return clone.textContent.trim();
  });
  grid.querySelectorAll('.grid-row:not(.grid-header)').forEach((row) => {
    [...row.querySelectorAll(':scope > .grid-cell')].forEach((cell, i) => {
      if (headers[i]) cell.dataset.label = headers[i];
    });
  });
}

function labelAll() {
  document.querySelectorAll('table').forEach(labelTable);
  document.querySelectorAll('.grid-table').forEach(labelGrid);
}

let scheduled = false;
function scheduleLabelAll() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    labelAll();
  });
}

export function initResponsiveTables() {
  labelAll();
  new MutationObserver(scheduleLabelAll).observe(document.body, { childList: true, subtree: true });
}
