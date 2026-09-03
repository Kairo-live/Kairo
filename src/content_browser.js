// Shared shell pieces for the Songs and Media library pickers in
// service.js. Both hand-roll a filter-rail + item-list/grid + empty-state
// trio; only the rail's chip-creation/active-toggle boilerplate and the
// "Recently Used" section shell were actually byte-for-byte duplicated
// between them, so that's all this factors out — row markup (a hymn row
// vs. a media card) stays with each caller since they're different enough
// that a shared item template would cost more than it saves.
//
// Loaded as a plain <script> alongside the other shared utility modules
// (design_space.js, color_utils.js, word_split.js), before service.js.

// "All X" chip + one chip per item, with active-state toggling. Media's
// rail also needs a per-chip delete affordance and a trailing "+ add"
// chip that Songs' fixed-category rail doesn't have — `buildExtra` lets
// a caller append that without this helper needing to know about it, and
// the trailing chip (if any) is still the caller's own to append after
// calling this, same as before the refactor.
function renderChipRail(rail, { items, getId, getLabel, activeId, allLabel, onSelect, buildExtra, chipTitle }) {
  if (!rail) return;
  rail.innerHTML = '';

  const allChip = document.createElement('button');
  allChip.className = 'media-folder-chip' + (activeId === null ? ' active' : '');
  allChip.textContent = allLabel;
  allChip.addEventListener('click', () => onSelect(null));
  rail.appendChild(allChip);

  items.forEach(item => {
    const id = getId(item);
    const chip = document.createElement('button');
    chip.className = 'media-folder-chip' + (activeId === id ? ' active' : '');
    chip.textContent = getLabel(item);
    if (chipTitle) chip.title = chipTitle(item);
    buildExtra?.(chip, item);
    chip.addEventListener('click', () => onSelect(id));
    rail.appendChild(chip);
  });
}

// "Recently Used" divider + items + "All ___" divider, appended into an
// already-cleared host. Returns whether it rendered anything, so the
// caller's own empty-state check stays independent of whether recents
// happened to be showing. `items` must already be resolved to whatever
// shape `buildItem` expects — resolving a raw recents-list entry against
// "does this still exist" is caller-specific (Songs re-checks against
// search results, Media just re-renders its stored snapshot), so that
// part intentionally isn't shared.
function renderRecentsSection(host, { items, buildItem, allLabel }) {
  if (!items.length) return false;
  const recentLabel = document.createElement('div');
  recentLabel.className = 'svc-section-label';
  recentLabel.textContent = 'Recently Used';
  host.appendChild(recentLabel);
  items.forEach(item => host.appendChild(buildItem(item)));
  const divider = document.createElement('div');
  divider.className = 'svc-section-label';
  divider.textContent = allLabel;
  host.appendChild(divider);
  return true;
}
