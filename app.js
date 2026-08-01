const API_URL = "https://script.google.com/macros/s/AKfycbxQ-4fs8MhOOVIPG_nW8JG2uotJcBruCmJ6RdMkeYJo91z2Tt3k6lgzHc0l8RZHBRtQsA/exec";

const FALLBACK_COLUMNS = [
  "Equipment_ID",
  "Name",
  "Status",
  "Condition",
  "Location",
  "Assigned_To",
  "Category",
  "Purchase_Date",
  "Last_Updated"
];

let inventoryCache = [];
let columnOrder = [...FALLBACK_COLUMNS];
let visibleInventory = [];
let selectedIds = new Set();
let activeStatus = "All";
let activeCategory = "All";
let searchQuery = "";
let currentView = "inventory";
let equipmentFormMode = "edit";
let editingOriginalId = "";
let previouslyFocusedElement = null;
let toastTimer = null;

let html5QrcodeScanner = null;
let scannerStateObserver = null;
let scanLocked = false;
let lastScannedId = "";
let lastScanTime = 0;
let audioContext = null;

document.addEventListener("DOMContentLoaded", async () => {
  setupMobileDockVisibility();
  bindInterfaceEvents();
  initScanner();
  await loadInventoryData();
  await handleInitialDeepLink();
});

function setupMobileDockVisibility() {
  const dock = document.querySelector(".mobile-dock");
  if (!dock) return;

  const mobileQuery = window.matchMedia("(max-width: 900px)");
  const syncDock = () => {
    document.documentElement.classList.toggle("is-mobile-layout", mobileQuery.matches);
    dock.setAttribute("aria-hidden", String(!mobileQuery.matches));
    if (mobileQuery.matches) dock.removeAttribute("inert");
    else dock.setAttribute("inert", "");
  };

  syncDock();
  if (typeof mobileQuery.addEventListener === "function") {
    mobileQuery.addEventListener("change", syncDock);
  } else if (typeof mobileQuery.addListener === "function") {
    mobileQuery.addListener(syncDock);
  }
}

function bindInterfaceEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  document.getElementById("sidebar-open").addEventListener("click", openSidebar);
  document.getElementById("sidebar-close").addEventListener("click", closeSidebar);
  document.getElementById("sidebar-overlay").addEventListener("click", closeSidebar);

  document.getElementById("add-equipment-button").addEventListener("click", () => openEquipmentModal("create"));
  document.getElementById("mobile-add-button").addEventListener("click", () => openEquipmentModal("create"));
  document.getElementById("mobile-dock-add").addEventListener("click", () => openEquipmentModal("create"));
  document.getElementById("refresh-data-button").addEventListener("click", () => loadInventoryData());
  document.getElementById("inventory-search").addEventListener("input", (event) => {
    searchQuery = event.target.value.trim().toLowerCase();
    renderInventory();
  });

  document.getElementById("status-filter").addEventListener("change", (event) => {
    setActiveStatus(event.target.value);
  });

  document.getElementById("category-filter").addEventListener("change", (event) => {
    activeCategory = event.target.value;
    renderInventory();
  });

  document.getElementById("status-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-status]");
    if (!tab) return;
    setActiveStatus(tab.dataset.status);
  });

  document.getElementById("inventory-table-head").addEventListener("change", (event) => {
    if (event.target.id !== "select-all-checkbox") return;
    visibleInventory.forEach((item) => {
      const id = safeValue(item.Equipment_ID);
      if (event.target.checked) selectedIds.add(id);
      else selectedIds.delete(id);
    });
    renderInventory();
  });

  document.getElementById("inventory-table-body").addEventListener("change", (event) => {
    if (!event.target.classList.contains("row-checkbox")) return;
    const equipmentId = event.target.dataset.equipmentId;
    if (event.target.checked) selectedIds.add(equipmentId);
    else selectedIds.delete(equipmentId);
    updateSelectionInterface();
    event.target.closest("tr")?.classList.toggle("is-selected", event.target.checked);
  });

  document.getElementById("inventory-table-body").addEventListener("click", (event) => {
    const qrButton = event.target.closest(".row-qr-button");
    const actionButton = event.target.closest(".row-action-button");
    const interactiveControl = event.target.closest("button, input, a, label");
    const row = event.target.closest("tr[data-equipment-id]");
    const equipmentId = qrButton?.dataset.equipmentId || actionButton?.dataset.equipmentId || (!interactiveControl && row?.dataset.equipmentId);
    if (!equipmentId) return;
    const item = inventoryCache.find((candidate) => safeValue(candidate.Equipment_ID) === equipmentId);
    if (!item) return;
    if (qrButton) openQrLabels([item], "single");
    else openEquipmentModal("edit", item);
  });

  document.getElementById("inventory-table-body").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target.closest("button, input, a, label")) return;
    const row = event.target.closest("tr[data-equipment-id]");
    if (!row) return;
    event.preventDefault();
    const item = inventoryCache.find(
      (candidate) => safeValue(candidate.Equipment_ID) === row.dataset.equipmentId
    );
    if (item) openEquipmentModal("edit", item);
  });

  document.getElementById("history-table-body").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-equipment-id]");
    if (!row) return;
    const item = inventoryCache.find(
      (candidate) => safeValue(candidate.Equipment_ID) === row.dataset.equipmentId
    );
    if (item) openEquipmentModal("edit", item);
  });

  document.getElementById("history-table-body").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("tr[data-equipment-id]");
    if (!row) return;
    event.preventDefault();
    const item = inventoryCache.find(
      (candidate) => safeValue(candidate.Equipment_ID) === row.dataset.equipmentId
    );
    if (item) openEquipmentModal("edit", item);
  });

  document.getElementById("clear-selection-button").addEventListener("click", () => {
    selectedIds.clear();
    renderInventory();
  });

  document.getElementById("create-qr-button").addEventListener("click", openSelectedQrLabels);
  document.getElementById("nav-qr-labels").addEventListener("click", () => {
    switchView("inventory");
    openSelectedQrLabels();
  });
  document.getElementById("export-csv-button").addEventListener("click", exportInventoryCsv);
  document.getElementById("nav-export").addEventListener("click", exportInventoryCsv);

  document.getElementById("equipment-form").addEventListener("submit", handleEquipmentSubmit);
  document.querySelectorAll("[data-close-equipment-modal]").forEach((element) => {
    element.addEventListener("click", closeEquipmentModal);
  });
  document.querySelectorAll("[data-close-qr-modal]").forEach((element) => {
    element.addEventListener("click", closeQrModal);
  });
  document.getElementById("print-labels-button").addEventListener("click", () => window.print());

  const manualForm = document.getElementById("manual-search-form");
  const manualInput = document.getElementById("manual-id-input");
  manualForm.addEventListener("submit", handleManualLookup);
  manualInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      manualForm.requestSubmit();
    }
  });

  document.addEventListener("keydown", (event) => {
    const tagName = document.activeElement?.tagName;
    const isTyping = tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";

    if (event.key === "/" && !isTyping && !isAnyModalOpen()) {
      event.preventDefault();
      switchView("inventory");
      document.getElementById("inventory-search").focus();
    }

    if (event.key === "Escape") {
      if (!document.getElementById("equipment-modal").hidden) closeEquipmentModal();
      else if (!document.getElementById("qr-modal").hidden) closeQrModal();
      else closeSidebar();
    }
  });
}

function switchView(viewName) {
  currentView = ["inventory", "scanner", "history"].includes(viewName) ? viewName : "inventory";
  document.getElementById("view-inventory").hidden = currentView !== "inventory";
  document.getElementById("view-scanner").hidden = currentView !== "scanner";
  document.getElementById("view-history").hidden = currentView !== "history";

  document.querySelectorAll("[data-view]").forEach((button) => {
    const isActive = button.dataset.view === currentView;
    button.classList.toggle("is-active", isActive);
    if (isActive) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  if (currentView === "scanner") resumeScanner();
  else pauseScanner();
  if (currentView === "history") renderHistory();

  closeSidebar();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openSidebar() {
  document.getElementById("sidebar").classList.add("is-open");
  document.getElementById("sidebar-overlay").hidden = false;
}

function closeSidebar() {
  document.getElementById("sidebar").classList.remove("is-open");
  document.getElementById("sidebar-overlay").hidden = true;
}

async function loadInventoryData(options = {}) {
  const refreshButton = document.getElementById("refresh-data-button");
  refreshButton.disabled = true;
  refreshButton.classList.add("is-loading");
  setConnectionState("Connecting", "connecting");

  if (!options.quiet && inventoryCache.length === 0) {
    renderTableMessage("Loading inventory…");
  }

  try {
    const result = await fetchJson(`${API_URL}?action=READ_ALL`);
    if (result.status !== "success" || !Array.isArray(result.data)) {
      throw new Error(result.message || "The inventory response was invalid.");
    }

    inventoryCache = result.data;
    columnOrder = collectColumnOrder(inventoryCache);
    selectedIds = new Set(
      [...selectedIds].filter((id) => inventoryCache.some((item) => safeValue(item.Equipment_ID) === id))
    );
    renderStatusCounts();
    populateCategoryFilter();
    renderInventory();
    renderHistory();
    setConnectionState("Sheet live", "online");
    document.getElementById("last-updated").textContent = `Updated ${formatTime(new Date())}`;
  } catch (error) {
    console.error("Inventory load failed:", error);
    setConnectionState("Connection issue", "offline");
    if (inventoryCache.length === 0) renderTableMessage("Inventory could not be loaded. Try Refresh.", true);
    if (!options.quiet) showToast(error.message || "Inventory could not be loaded.", "!", true);
  } finally {
    refreshButton.disabled = false;
    refreshButton.classList.remove("is-loading");
  }
}

function collectColumnOrder(data) {
  if (data.length === 0) return [...FALLBACK_COLUMNS];

  const discovered = [];
  data.forEach((item) => {
    Object.keys(item).forEach((key) => {
      if (!discovered.includes(key)) discovered.push(key);
    });
  });

  const priority = FALLBACK_COLUMNS.filter((column) => discovered.includes(column));
  const remaining = discovered.filter((column) => !priority.includes(column));
  return [...priority, ...remaining];
}

function renderStatusCounts() {
  const statusCount = (status) => inventoryCache.filter((item) => safeValue(item.Status) === status).length;
  document.getElementById("count-all").textContent = inventoryCache.length;
  document.getElementById("count-available").textContent = statusCount("Available");
  document.getElementById("count-in-use").textContent = statusCount("In Use");
  document.getElementById("count-maintenance").textContent = statusCount("Maintenance");
  document.getElementById("count-missing").textContent = statusCount("Missing");
  document.getElementById("sidebar-item-count").textContent = inventoryCache.length;
}

function setActiveStatus(status) {
  const allowedStatuses = ["All", "Available", "In Use", "Maintenance", "Missing"];
  activeStatus = allowedStatuses.includes(status) ? status : "All";
  document.getElementById("status-filter").value = activeStatus;
  document.querySelectorAll(".status-tab").forEach((button) => {
    const isActive = button.dataset.status === activeStatus;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
  renderInventory();
}

function populateCategoryFilter() {
  const select = document.getElementById("category-filter");
  const categories = [...new Set(
    inventoryCache.map((item) => safeValue(item.Category)).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  const options = [new Option("All categories", "All")];
  categories.forEach((category) => options.push(new Option(category, category)));
  select.replaceChildren(...options);
  if (activeCategory !== "All" && !categories.includes(activeCategory)) activeCategory = "All";
  select.value = activeCategory;
}

function renderInventory() {
  visibleInventory = inventoryCache.filter((item) => {
    const matchesStatus = activeStatus === "All" || safeValue(item.Status) === activeStatus;
    const matchesCategory = activeCategory === "All" || safeValue(item.Category) === activeCategory;
    const searchFields = ["Equipment_ID", "Name", "Category", "Location", "Assigned_To"];
    const matchesSearch = !searchQuery || searchFields.some((field) =>
      String(item[field] ?? "").toLowerCase().includes(searchQuery)
    );
    return matchesStatus && matchesCategory && matchesSearch;
  });

  renderTableHead();
  renderTableBody();
  updateSelectionInterface();
  document.getElementById("result-summary").textContent =
    `Showing ${visibleInventory.length} of ${inventoryCache.length} equipment records`;
}

function renderHistory() {
  const body = document.getElementById("history-table-body");
  const summary = document.getElementById("history-summary");
  if (!body || !summary) return;

  const updates = [...inventoryCache].sort((a, b) => {
    const aTime = new Date(safeValue(a.Last_Updated)).getTime() || 0;
    const bTime = new Date(safeValue(b.Last_Updated)).getTime() || 0;
    return bTime - aTime;
  });

  if (updates.length === 0) {
    const row = document.createElement("tr");
    row.className = "message-row";
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "No recent equipment updates are available.";
    row.appendChild(cell);
    body.replaceChildren(row);
    summary.textContent = "No update history available";
    return;
  }

  const fragment = document.createDocumentFragment();
  updates.forEach((item) => {
    const equipmentId = safeValue(item.Equipment_ID, "Unknown ID");
    const row = document.createElement("tr");
    row.className = "history-row";
    row.dataset.equipmentId = equipmentId;
    row.tabIndex = 0;
    row.setAttribute("aria-label", `Edit ${equipmentId}`);

    const updatedCell = document.createElement("td");
    updatedCell.textContent = formatHistoryDate(item.Last_Updated);

    const equipmentCell = document.createElement("td");
    const equipmentWrap = document.createElement("span");
    equipmentWrap.className = "history-equipment";
    const equipmentName = document.createElement("strong");
    equipmentName.textContent = safeValue(item.Name, "Unnamed equipment");
    const equipmentCode = document.createElement("span");
    equipmentCode.textContent = equipmentId;
    equipmentWrap.append(equipmentName, equipmentCode);
    equipmentCell.appendChild(equipmentWrap);

    const statusCell = document.createElement("td");
    const statusPill = document.createElement("span");
    statusPill.className = `status-pill ${statusClassName(safeValue(item.Status))}`;
    statusPill.textContent = safeValue(item.Status, "Not set");
    statusCell.appendChild(statusPill);

    const locationCell = document.createElement("td");
    locationCell.textContent = safeValue(item.Location, "—");
    const assignedCell = document.createElement("td");
    assignedCell.textContent = safeValue(item.Assigned_To, "Unassigned");

    row.append(updatedCell, equipmentCell, statusCell, locationCell, assignedCell);
    fragment.appendChild(row);
  });

  body.replaceChildren(fragment);
  summary.textContent = `Showing ${updates.length} recent equipment updates`;
}

function renderTableHead() {
  const table = document.getElementById("inventory-table");
  const head = document.getElementById("inventory-table-head");
  const row = document.createElement("tr");
  table.style.setProperty("--data-columns", columnOrder.length);

  const checkboxHeader = document.createElement("th");
  checkboxHeader.className = "checkbox-cell";
  const selectAll = document.createElement("input");
  selectAll.id = "select-all-checkbox";
  selectAll.type = "checkbox";
  selectAll.setAttribute("aria-label", "Select all visible equipment");
  checkboxHeader.appendChild(selectAll);
  row.appendChild(checkboxHeader);

  columnOrder.forEach((column) => {
    const header = document.createElement("th");
    header.scope = "col";
    header.textContent = formatColumnName(column);
    row.appendChild(header);
  });

  const actionHeader = document.createElement("th");
  actionHeader.scope = "col";
  actionHeader.className = "action-cell";
  const actionLabel = document.createElement("span");
  actionLabel.className = "sr-only";
  actionLabel.textContent = "Actions";
  actionHeader.appendChild(actionLabel);
  row.appendChild(actionHeader);
  head.replaceChildren(row);
}

function renderTableBody() {
  const body = document.getElementById("inventory-table-body");
  body.replaceChildren();

  if (visibleInventory.length === 0) {
    renderTableMessage(searchQuery || activeStatus !== "All" || activeCategory !== "All" ? "No equipment matches these filters." : "No equipment records found.");
    return;
  }

  visibleInventory.forEach((item) => {
    const equipmentId = safeValue(item.Equipment_ID);
    const row = document.createElement("tr");
    row.className = "equipment-row";
    row.dataset.equipmentId = equipmentId;
    row.tabIndex = 0;
    row.setAttribute("aria-label", `Edit ${equipmentId || "equipment"}`);
    if (selectedIds.has(equipmentId)) row.classList.add("is-selected");

    const checkboxCell = document.createElement("td");
    checkboxCell.className = "checkbox-cell";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "row-checkbox";
    checkbox.checked = selectedIds.has(equipmentId);
    checkbox.dataset.equipmentId = equipmentId;
    checkbox.setAttribute("aria-label", `Select ${equipmentId || "equipment"}`);
    checkboxCell.appendChild(checkbox);
    row.appendChild(checkboxCell);

    columnOrder.forEach((column) => {
      const cell = document.createElement("td");
      const value = safeValue(item[column], "—");
      cell.dataset.label = formatColumnName(column);
      cell.title = value === "—" ? "" : value;

      if (column === "Equipment_ID") {
        cell.className = "id-cell";
        cell.appendChild(createEquipmentIdCell(item));
      } else if (column === "Status") {
        const status = document.createElement("span");
        status.className = `status-pill ${statusClassName(value)}`;
        status.textContent = value;
        cell.appendChild(status);
      } else {
        cell.textContent = value;
      }
      row.appendChild(cell);
    });

    const actionCell = document.createElement("td");
    actionCell.className = "action-cell";
    actionCell.dataset.label = "Actions";
    const actionGroup = document.createElement("div");
    actionGroup.className = "row-actions";
    const qrButton = document.createElement("button");
    qrButton.type = "button";
    qrButton.className = "row-qr-button";
    qrButton.dataset.equipmentId = equipmentId;
    qrButton.setAttribute("aria-label", `QR Label ${equipmentId || "equipment"}`);
    qrButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v6h-6v-2M16 18h2"></path></svg><span>QR Label</span>';
    const actionButton = document.createElement("button");
    actionButton.type = "button";
    actionButton.className = "row-action-button";
    actionButton.dataset.equipmentId = equipmentId;
    actionButton.setAttribute("aria-label", `Edit ${equipmentId || "equipment"}`);
    actionButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"></circle><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"></circle></svg>';
    actionGroup.append(qrButton, actionButton);
    actionCell.appendChild(actionGroup);
    row.appendChild(actionCell);
    body.appendChild(row);
  });
}

function createEquipmentIdCell(item) {
  const wrapper = document.createElement("div");
  wrapper.className = "id-wrap";

  const avatar = document.createElement("span");
  avatar.className = "equipment-avatar";
  avatar.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3zM4 7.5l8 4.5 8-4.5M12 12v9"></path></svg>';

  const copy = document.createElement("span");
  const main = document.createElement("span");
  const sub = document.createElement("span");
  main.className = "cell-main";
  sub.className = "cell-sub";
  main.textContent = safeValue(item.Equipment_ID, "No ID");
  sub.textContent = safeValue(item.Name, "Unnamed equipment");
  copy.append(main, sub);
  wrapper.append(avatar, copy);
  return wrapper;
}

function renderTableMessage(message, isError = false) {
  const head = document.getElementById("inventory-table-head");
  const body = document.getElementById("inventory-table-body");
  if (!head.children.length) renderTableHead();

  const row = document.createElement("tr");
  row.className = `message-row${isError ? " is-error" : ""}`;
  const cell = document.createElement("td");
  cell.colSpan = columnOrder.length + 2;
  cell.textContent = message;
  row.appendChild(cell);
  body.replaceChildren(row);
}

function updateSelectionInterface() {
  const selectedCount = selectedIds.size;
  const selectionBar = document.getElementById("selection-bar");
  selectionBar.hidden = selectedCount === 0;
  document.getElementById("selected-count").textContent = selectedCount;
  document.getElementById("create-qr-button").disabled = selectedCount === 0;

  const selectAll = document.getElementById("select-all-checkbox");
  if (selectAll) {
    const visibleIds = visibleInventory.map((item) => safeValue(item.Equipment_ID));
    const selectedVisibleCount = visibleIds.filter((id) => selectedIds.has(id)).length;
    selectAll.checked = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
    selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleIds.length;
  }
}

function openEquipmentModal(mode, item = {}) {
  equipmentFormMode = mode;
  editingOriginalId = mode === "edit" ? safeValue(item.Equipment_ID) : "";
  previouslyFocusedElement = document.activeElement;

  document.getElementById("equipment-modal-kicker").textContent = mode === "create" ? "New inventory record" : safeValue(item.Equipment_ID, "Equipment record");
  document.getElementById("equipment-modal-title").textContent = mode === "create" ? "Add equipment" : "Edit equipment";
  document.getElementById("equipment-modal-description").textContent = mode === "create"
    ? "Complete the fields below to add an item to the inventory."
    : "Every value returned by the Sheet can be edited here.";
  document.getElementById("save-equipment-button").textContent = mode === "create" ? "Add equipment" : "Save changes";

  renderEquipmentFields(item);
  openModal(document.getElementById("equipment-modal"));
  requestAnimationFrame(() => document.querySelector("#equipment-fields [data-column]")?.focus());
}

function renderEquipmentFields(item) {
  const fields = document.getElementById("equipment-fields");
  fields.replaceChildren();

  columnOrder.filter((column) => !isSystemManagedColumn(column)).forEach((column) => {
    const field = document.createElement("div");
    field.className = "dynamic-field";
    const normalizedColumn = column.toLowerCase();
    field.dataset.columnKey = normalizedColumn.replace(/[^a-z0-9]+/g, "-");
    if (/notes|description|remarks|details/.test(normalizedColumn)) field.classList.add("is-wide");

    const label = document.createElement("label");
    const inputId = `field-${column.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    label.className = "field-label";
    label.htmlFor = inputId;
    label.textContent = formatColumnName(column);

    let fieldValue = safeValue(item[column]);
    if (equipmentFormMode === "create" && column === "Status") fieldValue = "Available";
    if (equipmentFormMode === "create" && column === "Condition") fieldValue = "Good";
    const input = createFieldControl(column, fieldValue);
    input.id = inputId;
    input.dataset.column = column;
    if (column === "Equipment_ID") {
      input.required = true;
      input.autocapitalize = "characters";
      input.spellcheck = false;
    }
    if (column === "Name") input.required = true;

    field.append(label, input);
    if (column === "Equipment_ID" && equipmentFormMode === "edit") {
      const help = document.createElement("small");
      help.textContent = "Changing the ID also changes the QR label value. Backend rename support is required.";
      field.appendChild(help);
    }
    fields.appendChild(field);
  });
}

function createFieldControl(column, value) {
  const normalized = column.toLowerCase();

  if (/notes|description|remarks|details/.test(normalized)) {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    return textarea;
  }

  const input = document.createElement("input");
  input.value = value;

  if (/date|purchased|created|updated/.test(normalized) && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    input.type = "date";
    input.value = value.slice(0, 10);
  } else if (/cost|price|amount|quantity|qty|value/.test(normalized)) {
    input.type = "number";
    input.step = "any";
  } else {
    input.type = "text";
  }

  if (column === "Status") input.setAttribute("list", "status-options");
  if (column === "Condition") input.setAttribute("list", "condition-options");
  return input;
}

function isSystemManagedColumn(column) {
  const normalized = String(column).trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ["last_updated", "updated_at", "modified_at", "timestamp"].includes(normalized);
}

async function handleEquipmentSubmit(event) {
  event.preventDefault();
  const saveButton = document.getElementById("save-equipment-button");
  const data = {};

  document.querySelectorAll("#equipment-fields [data-column]").forEach((input) => {
    data[input.dataset.column] = input.value.trim();
  });

  data.Equipment_ID = normalizeEquipmentId(data.Equipment_ID);
  if (!data.Equipment_ID || !safeValue(data.Name)) {
    showToast("Equipment ID and Name are required.", "!", true);
    return;
  }

  const originalLabel = saveButton.textContent;
  saveButton.disabled = true;
  saveButton.textContent = equipmentFormMode === "create" ? "Adding…" : "Saving…";

  try {
    const action = equipmentFormMode === "create" ? "CREATE" : "UPDATE";
    const result = await fetchJson(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, data, originalEquipmentId: editingOriginalId })
    });

    if (result.status !== "success") {
      throw new Error(result.message || `${action} was rejected by the backend.`);
    }

    if (editingOriginalId && editingOriginalId !== data.Equipment_ID) selectedIds.delete(editingOriginalId);
    closeEquipmentModal();
    showToast(equipmentFormMode === "create" ? "Equipment added successfully." : "Equipment updated successfully.");
    await loadInventoryData({ quiet: true });
  } catch (error) {
    console.error("Equipment save failed:", error);
    showToast(error.message || "Equipment could not be saved.", "!", true);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = originalLabel;
  }
}

function closeEquipmentModal() {
  closeModal(document.getElementById("equipment-modal"));
  scanLocked = false;
  if (currentView === "scanner") resumeScanner();
}

function openSelectedQrLabels() {
  const selectedItems = inventoryCache.filter((item) => selectedIds.has(safeValue(item.Equipment_ID)));
  if (selectedItems.length === 0) {
    showToast("Select one or more equipment rows to create labels.", "!", true);
    return;
  }
  openQrLabels(selectedItems, "bulk");
}

function openQrLabels(items, mode = items.length === 1 ? "single" : "bulk") {
  if (typeof QRCode === "undefined") {
    showToast("The QR generator could not be loaded.", "!", true);
    return;
  }

  const grid = document.getElementById("print-area");
  grid.replaceChildren();
  grid.classList.toggle("is-single", mode === "single");
  document.getElementById("qr-modal-title").textContent = mode === "single" ? "Equipment QR label" : "Printable QR label sheet";
  document.getElementById("qr-modal-description").textContent = mode === "single"
    ? "Preview, download, or print this equipment sticker."
    : `Ready to print ${items.length} selected equipment labels.`;
  document.getElementById("print-labels-button").lastChild.textContent = mode === "single" ? "Print Label" : "Print Sheet";
  previouslyFocusedElement = document.activeElement;

  items.forEach((item) => {
    const equipmentId = safeValue(item.Equipment_ID);
    const deepLink = getEquipmentDeepLink(equipmentId);
    const label = document.createElement("article");
    label.className = "qr-label";
    label.dataset.deepLink = deepLink;

    const brand = document.createElement("span");
    brand.className = "qr-label-brand";
    brand.textContent = "EquipTrack";
    const title = document.createElement("h3");
    title.textContent = safeValue(item.Name, "Unnamed equipment");
    const category = document.createElement("p");
    category.className = "qr-label-category";
    category.textContent = safeValue(item.Category, "Uncategorized");
    const qrCanvas = document.createElement("div");
    qrCanvas.className = "qr-canvas";
    const equipmentCode = document.createElement("strong");
    equipmentCode.className = "qr-equipment-id";
    equipmentCode.textContent = equipmentId;
    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.className = "download-qr-button";
    downloadButton.textContent = "Download PNG";
    downloadButton.addEventListener("click", () => downloadQrPng(qrCanvas, equipmentId));

    label.append(brand, title, category, qrCanvas, equipmentCode, downloadButton);
    grid.appendChild(label);

    try {
      new QRCode(qrCanvas, {
        text: deepLink,
        width: 192,
        height: 192,
        colorDark: "#151515",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.H
      });
    } catch (error) {
      qrCanvas.textContent = error.message;
      downloadButton.disabled = true;
    }
  });

  openModal(document.getElementById("qr-modal"));
}

function getEquipmentDeepLink(equipmentId) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("id", equipmentId);
  return url.toString();
}

// Dependency-free QR encoder for short equipment IDs (QR Version 1-L, up to 17 UTF-8 bytes).
function renderQrCode(container, text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 17) {
    throw new Error("Equipment ID is too long for this label format.");
  }

  const dataBits = [];
  const appendBits = (value, length) => {
    for (let bit = length - 1; bit >= 0; bit -= 1) dataBits.push((value >>> bit) & 1);
  };

  appendBits(0x4, 4); // Byte mode.
  appendBits(bytes.length, 8);
  bytes.forEach((byte) => appendBits(byte, 8));

  const dataCapacityBits = 19 * 8;
  appendBits(0, Math.min(4, dataCapacityBits - dataBits.length));
  while (dataBits.length % 8 !== 0) dataBits.push(0);

  let padByte = 0xec;
  while (dataBits.length < dataCapacityBits) {
    appendBits(padByte, 8);
    padByte = padByte === 0xec ? 0x11 : 0xec;
  }

  const dataCodewords = [];
  for (let index = 0; index < dataBits.length; index += 8) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | dataBits[index + bit];
    dataCodewords.push(value);
  }

  const errorCorrection = reedSolomonRemainder(dataCodewords, 7);
  const codewords = [...dataCodewords, ...errorCorrection];
  const size = 21;
  const modules = Array.from({ length: size }, () => Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));

  const setFunctionModule = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = Boolean(dark);
    reserved[y][x] = true;
  };

  const drawFinder = (left, top) => {
    for (let y = -1; y <= 7; y += 1) {
      for (let x = -1; x <= 7; x += 1) {
        const inside = x >= 0 && x <= 6 && y >= 0 && y <= 6;
        const dark = inside && (
          x === 0 || x === 6 || y === 0 || y === 6 ||
          (x >= 2 && x <= 4 && y >= 2 && y <= 4)
        );
        setFunctionModule(left + x, top + y, dark);
      }
    }
  };

  for (let index = 0; index < size; index += 1) {
    setFunctionModule(6, index, index % 2 === 0);
    setFunctionModule(index, 6, index % 2 === 0);
  }
  drawFinder(0, 0);
  drawFinder(size - 7, 0);
  drawFinder(0, size - 7);
  setFunctionModule(8, size - 8, true);

  const formatData = 0b01000; // Error correction level L, mask 0.
  let remainder = formatData;
  for (let index = 0; index < 10; index += 1) {
    remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537);
  }
  const formatBits = ((formatData << 10) | remainder) ^ 0x5412;
  const formatBit = (index) => ((formatBits >>> index) & 1) !== 0;

  for (let index = 0; index <= 5; index += 1) setFunctionModule(8, index, formatBit(index));
  setFunctionModule(8, 7, formatBit(6));
  setFunctionModule(8, 8, formatBit(7));
  setFunctionModule(7, 8, formatBit(8));
  for (let index = 9; index < 15; index += 1) setFunctionModule(14 - index, 8, formatBit(index));
  for (let index = 0; index < 8; index += 1) setFunctionModule(size - 1 - index, 8, formatBit(index));
  for (let index = 8; index < 15; index += 1) setFunctionModule(8, size - 15 + index, formatBit(index));

  let dataIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      const upward = ((right + 1) & 2) === 0;
      const y = upward ? size - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        if (reserved[y][x]) continue;
        const codeword = codewords[dataIndex >>> 3] || 0;
        let dark = ((codeword >>> (7 - (dataIndex & 7))) & 1) !== 0;
        if ((x + y) % 2 === 0) dark = !dark;
        modules[y][x] = dark;
        dataIndex += 1;
      }
    }
  }

  const quietZone = 4;
  const scale = 5;
  const canvas = document.createElement("canvas");
  canvas.width = (size + quietZone * 2) * scale;
  canvas.height = canvas.width;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `QR code for ${text}`);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#151515";

  modules.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) context.fillRect((x + quietZone) * scale, (y + quietZone) * scale, scale, scale);
  }));

  container.replaceChildren(canvas);
}

function reedSolomonRemainder(data, degree) {
  const divisor = reedSolomonDivisor(degree);
  const result = Array(degree).fill(0);
  data.forEach((byte) => {
    const factor = byte ^ result.shift();
    result.push(0);
    divisor.forEach((coefficient, index) => {
      result[index] ^= gfMultiply(coefficient, factor);
    });
  });
  return result;
}

function reedSolomonDivisor(degree) {
  const result = Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let index = 0; index < degree; index += 1) {
    for (let coefficient = 0; coefficient < degree; coefficient += 1) {
      result[coefficient] = gfMultiply(result[coefficient], root);
      if (coefficient + 1 < degree) result[coefficient] ^= result[coefficient + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function gfMultiply(left, right) {
  let x = left;
  let y = right;
  let result = 0;
  for (let index = 0; index < 8; index += 1) {
    if ((y & 1) !== 0) result ^= x;
    y >>>= 1;
    x = (x << 1) ^ (((x >>> 7) & 1) * 0x11d);
  }
  return result & 0xff;
}

function downloadQrPng(qrContainer, equipmentId) {
  const canvas = qrContainer.querySelector("canvas");
  const image = qrContainer.querySelector("img");
  let downloadUrl = image?.src;

  if (canvas) {
    const quietZone = 16;
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = canvas.width + (quietZone * 2);
    exportCanvas.height = canvas.height + (quietZone * 2);
    const context = exportCanvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    context.drawImage(canvas, quietZone, quietZone);
    downloadUrl = exportCanvas.toDataURL("image/png");
  }

  if (!downloadUrl) {
    showToast("QR image is still being prepared. Try again.", "!", true);
    return;
  }

  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = `${sanitizeFileName(equipmentId || "equipment")}-qr.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function closeQrModal() {
  closeModal(document.getElementById("qr-modal"));
}

function exportInventoryCsv() {
  const selectedItems = inventoryCache.filter((item) => selectedIds.has(safeValue(item.Equipment_ID)));
  const exportData = selectedItems.length > 0 ? selectedItems : visibleInventory;

  if (exportData.length === 0) {
    showToast("There are no equipment rows to export.", "!", true);
    return;
  }

  const rows = [columnOrder, ...exportData.map((item) => columnOrder.map((column) => item[column] ?? ""))];
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `equipment-inventory-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast(`Exported ${exportData.length} equipment row${exportData.length === 1 ? "" : "s"}.`);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function openModal(modal) {
  previouslyFocusedElement = document.activeElement;
  modal.hidden = false;
  document.body.classList.add("modal-open");
}

function closeModal(modal) {
  if (modal.hidden) return;
  modal.hidden = true;
  if (!isAnyModalOpen()) document.body.classList.remove("modal-open");
  if (previouslyFocusedElement instanceof HTMLElement) previouslyFocusedElement.focus();
}

function isAnyModalOpen() {
  return !document.getElementById("equipment-modal").hidden || !document.getElementById("qr-modal").hidden;
}

function initScanner() {
  if (typeof Html5QrcodeScanner === "undefined") {
    setCameraStatus("Scanner unavailable", "error");
    return;
  }

  try {
    html5QrcodeScanner = new Html5QrcodeScanner("reader", {
      fps: 10,
      qrbox: { width: 250, height: 250 },
      aspectRatio: 1,
      rememberLastUsedCamera: true,
      showTorchButtonIfSupported: true
    }, false);
    html5QrcodeScanner.render(onScanSuccess, () => {});
    observeScannerState();
  } catch (error) {
    console.error("Scanner initialization failed:", error);
    setCameraStatus("Scanner unavailable", "error");
  }
}

function observeScannerState() {
  const reader = document.getElementById("reader");
  scannerStateObserver?.disconnect();
  scannerStateObserver = new MutationObserver(() => {
    const text = reader.textContent || "";
    if (reader.querySelector("video")) setCameraStatus("Scanning", "active");
    else if (/NotAllowedError|Permission denied/i.test(text)) setCameraStatus("Camera blocked", "error");
    else if (/Requesting camera permissions/i.test(text)) setCameraStatus("Requesting access", "active");
  });
  scannerStateObserver.observe(reader, { childList: true, subtree: true, characterData: true });
}

function onScanSuccess(decodedText) {
  const equipmentId = normalizeEquipmentId(decodedText);
  const now = Date.now();
  if (!equipmentId || scanLocked || (equipmentId === lastScannedId && now - lastScanTime < 2500)) return;

  scanLocked = true;
  lastScannedId = equipmentId;
  lastScanTime = now;
  pauseScanner();
  playBeep();
  showToast(`Scanned ${equipmentId}`);
  findAndOpenEquipment(equipmentId).then((found) => {
    if (!found) {
      scanLocked = false;
      resumeScanner();
    }
  });
}

function handleManualLookup(event) {
  event.preventDefault();
  const input = document.getElementById("manual-id-input");
  const equipmentId = normalizeEquipmentId(input.value);
  if (!equipmentId) {
    showToast("Enter an equipment ID.", "!", true);
    input.focus();
    return;
  }
  input.value = equipmentId;
  findAndOpenEquipment(equipmentId);
}

async function handleInitialDeepLink() {
  const requestedId = new URLSearchParams(window.location.search).get("id");
  if (!requestedId) return;

  const equipmentId = normalizeEquipmentId(requestedId);
  if (!equipmentId) {
    showToast("The equipment link is invalid.", "!", true);
    return;
  }

  switchView("scanner");
  await fetchAndOpenModal(equipmentId);
}

async function fetchAndOpenModal(equipmentId) {
  return findAndOpenEquipment(normalizeEquipmentId(equipmentId));
}

async function findAndOpenEquipment(equipmentId) {
  let item = inventoryCache.find(
    (candidate) => safeValue(candidate.Equipment_ID).toUpperCase() === equipmentId.toUpperCase()
  );

  if (!item) {
    try {
      const result = await fetchJson(`${API_URL}?action=READ_ONE&equipmentId=${encodeURIComponent(equipmentId)}`);
      if (result.status === "success" && result.data) item = result.data;
    } catch (error) {
      console.error("Equipment lookup failed:", error);
      showToast("The inventory service could not be reached.", "!", true);
      return false;
    }
  }

  if (!item) {
    showToast(`No equipment found for ${equipmentId}.`, "!", true);
    return false;
  }

  openEquipmentModal("edit", item);
  return true;
}

function pauseScanner() {
  if (!html5QrcodeScanner || typeof html5QrcodeScanner.pause !== "function") return;
  try { html5QrcodeScanner.pause(true); } catch (error) {}
}

function resumeScanner() {
  if (!html5QrcodeScanner || typeof html5QrcodeScanner.resume !== "function") return;
  try { html5QrcodeScanner.resume(); } catch (error) {}
}

function setCameraStatus(label, state) {
  const status = document.getElementById("camera-status");
  status.lastChild.textContent = label;
  status.classList.toggle("is-active", state === "active");
  status.classList.toggle("is-error", state === "error");
}

function setConnectionState(label, state) {
  const dot = document.getElementById("connection-dot");
  document.getElementById("connection-label").textContent = label;
  dot.classList.toggle("is-online", state === "online");
  dot.classList.toggle("is-offline", state === "offline");
}

async function fetchJson(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`Inventory service returned HTTP ${response.status}.`);
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The inventory service took too long to respond.");
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeEquipmentId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = raw.match(/EQ-[A-Z0-9-]+/i);
  return (match ? match[0] : raw).toUpperCase();
}

function formatColumnName(column) {
  return String(column)
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusClassName(status) {
  const classes = {
    "Available": "status-available",
    "In Use": "status-in-use",
    "Maintenance": "status-maintenance",
    "Missing": "status-missing"
  };
  return classes[status] || "status-default";
}

function safeValue(value, fallback = "") {
  const normalized = value == null ? "" : String(value).trim();
  return normalized || fallback;
}

function sanitizeFileName(value) {
  return String(value).replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") || "equipment";
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatHistoryDate(value) {
  const rawValue = safeValue(value);
  if (!rawValue) return "Not recorded";
  const date = new Date(rawValue);
  if (Number.isNaN(date.getTime())) return rawValue;
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function showToast(message, icon = "✓", isError = false) {
  const toast = document.getElementById("toast");
  document.getElementById("toast-message").textContent = message;
  document.getElementById("toast-icon").textContent = icon;
  toast.classList.toggle("is-error", isError);
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function playBeep() {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
    gain.gain.setValueAtTime(0.04, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.12);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.12);
  } catch (error) {}
}
