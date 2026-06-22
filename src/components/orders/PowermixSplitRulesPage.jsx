import React, { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Plus, Pencil, Trash2, Search, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/notifications";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const SOURCE_LINES = ["Line 5", "Line 7"];
const TARGET_LINES = ["Line 1", "Line 2", "Line 3", "Line 4", "Line 6", "Line 7"];

const EMPTY_RULE = {
  fg_code: "",
  fg_description: "",
  sfg_material_code: "",
  sfg1_material_code: "",
  source_line: "Line 5",
  target_line: "Line 2",
  percentage: "",
  batch_size: 4,
  is_active: true,
  remarks: "",
};

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export default function PowermixSplitRulesPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [showDialog, setShowDialog] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [form, setForm] = useState(EMPTY_RULE);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [isApplying, setIsApplying] = useState(false);
  const [formErrors, setFormErrors] = useState({});

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ["powermix-split-rules"],
    queryFn: () => apiFetch("/api/powermix-split-rules"),
  });

  async function _autoApply() {
    try {
      setIsApplying(true);
      const res = await apiFetch("/api/powermix/apply-all", { method: "POST" });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      const { updated = 0 } = res.stats || {};
      if (updated > 0) toast.success(`${updated} generated order${updated === 1 ? "" : "s"} synced`);
    } catch { /* silent */ }
    finally { setIsApplying(false); }
  }

  const createMutation = useMutation({
    mutationFn: (data) => apiFetch("/api/powermix-split-rules", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["powermix-split-rules"] }); toast.success("Rule created"); setShowDialog(false); _autoApply(); },
    onError: (e) => toast.error("Failed: " + e.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }) => apiFetch(`/api/powermix-split-rules/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["powermix-split-rules"] }); toast.success("Rule updated"); setShowDialog(false); _autoApply(); },
    onError: (e) => toast.error("Failed: " + e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => apiFetch(`/api/powermix-split-rules/${id}`, { method: "DELETE" }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["powermix-split-rules"] }); toast.success("Rule deleted"); setDeleteTarget(null); },
    onError: (e) => toast.error("Failed: " + e.message),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, ...data }) => apiFetch(`/api/powermix-split-rules/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["powermix-split-rules"] }),
    onError: (e) => toast.error("Failed: " + e.message),
  });

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return rules;
    return rules.filter((r) =>
      [r.fg_code, r.fg_description, r.sfg_material_code, r.sfg1_material_code, r.target_line]
        .some((v) => String(v || "").toLowerCase().includes(q))
    );
  }, [rules, search]);

  function openAdd() {
    setEditingRule(null);
    setForm(EMPTY_RULE);
    setFormErrors({});
    setShowDialog(true);
  }

  function openEdit(rule) {
    setEditingRule(rule);
    setForm({
      fg_code: rule.fg_code || "",
      fg_description: rule.fg_description || "",
      sfg_material_code: rule.sfg_material_code || "",
      sfg1_material_code: rule.sfg1_material_code || "",
      source_line: rule.source_line || "Line 5",
      target_line: rule.target_line || "Line 2",
      percentage: rule.percentage != null ? String(rule.percentage) : "",
      batch_size: rule.batch_size ?? 4,
      is_active: rule.is_active === true || rule.is_active === "true",
      remarks: rule.remarks || "",
    });
    setFormErrors({});
    setShowDialog(true);
  }

  function validate() {
    const errs = {};
    if (!form.fg_code.trim()) errs.fg_code = "Required";
    if (!form.sfg_material_code.trim()) errs.sfg_material_code = "Required";
    if (!form.target_line) errs.target_line = "Required";
    const pct = parseFloat(form.percentage);
    if (isNaN(pct) || pct <= 0 || pct > 100) errs.percentage = "Must be 1–100";
    const bs = parseInt(form.batch_size);
    if (isNaN(bs) || bs <= 0) errs.batch_size = "Must be > 0";
    setFormErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleSave() {
    if (!validate()) return;
    const payload = {
      ...form,
      percentage: parseFloat(form.percentage),
      batch_size: parseInt(form.batch_size),
      is_active: form.is_active === true || form.is_active === "true",
    };
    if (editingRule) {
      updateMutation.mutate({ id: editingRule.id, ...payload });
    } else {
      createMutation.mutate(payload);
    }
  }

  async function handleApplyAll() {
    setIsApplying(true);
    try {
      const res = await apiFetch("/api/powermix/apply-all", { method: "POST" });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      const { created = 0, updated = 0, cancelled = 0, skipped = 0 } = res.stats || {};
      toast.success(`Rules applied — ${created} created, ${updated} updated, ${cancelled} cancelled, ${skipped} unchanged`);
    } catch (e) {
      toast.error("Apply failed: " + e.message);
    } finally {
      setIsApplying(false);
    }
  }

  function handleExport() {
    const headers = ["FG Code", "FG Description", "SFG Material Code", "SFG1 Material Code", "Target Line", "Percentage (%)", "Batch Size", "Active", "Remarks"];
    const rows = rules.map((r) => [
      r.fg_code, r.fg_description, r.sfg_material_code, r.sfg1_material_code,
      r.target_line, r.percentage, r.batch_size,
      r.is_active === true || r.is_active === "true" ? "Yes" : "No",
      r.remarks,
    ]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v || "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "powermix_split_rules.csv";
    a.click();
  }

  const activeCount = rules.filter((r) => r.is_active === true || r.is_active === "true").length;

  return (
    <Card className="border-0 shadow-sm" data-tour="powermix-split-page">
      <CardHeader className="pb-4" data-tour="powermix-split-header">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <GitBranch className="h-8 w-8 text-[var(--nexfeed-primary)]" />
            <div>
              <CardTitle className="text-[16px]">Powermix Split Rules</CardTitle>
              <p className="text-[12px] text-gray-500 mt-0.5">
                When a qualifying FG is scheduled on <strong>Line 5 (Powermix)</strong>, the system automatically creates a linked order on the configured destination line.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline" size="sm"
              onClick={handleApplyAll}
              disabled={isApplying}
              className="text-[10px]"
              data-testid="button-apply-powermix-rules"
            >
              <RefreshCw className={`h-3 w-3 mr-1 ${isApplying ? "animate-spin" : ""}`} />
              {isApplying ? "Applying…" : "Apply Rules Now"}
            </Button>
            <Button
              size="sm"
              onClick={openAdd}
              className="bg-[var(--nexfeed-primary)] hover:bg-[var(--nexfeed-primary-dark)] text-white text-[10px]"
              data-testid="button-add-powermix-rule"
            >
              <Plus className="h-3 w-3 mr-1" /> Add Rule
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">

      {/* ── Search + count ── */}
      <div className="flex items-center gap-3" data-tour="powermix-split-search">
        <div className="relative" style={{ maxWidth: 300, flex: 1 }}>
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <Input
            placeholder="Search by FG code, description, or target line…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 text-xs h-8"
            data-testid="input-powermix-search"
          />
        </div>
        <span className="text-[11px] text-gray-500 whitespace-nowrap">
          Showing {filtered.length} of {rules.length} rules
        </span>
      </div>

      {/* ── Table card ── */}
      <div className="pm-table-light border border-gray-200 rounded-xl overflow-hidden" data-tour="powermix-split-table">

        {/* ── Table ── */}
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              {/* Column group row */}
              <tr className="bg-gray-50 border-b border-gray-100">
                <th colSpan={5} className="px-3 pt-3 pb-1 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                  Rule Configuration
                </th>
                <th colSpan={2} className="px-3 pt-3 pb-1 text-center text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                  Routing
                </th>
                <th colSpan={3} className="px-3 pt-3 pb-1 text-center text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                  Split Settings
                </th>
                <th colSpan={2} className="px-3 pt-3 pb-1 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                  &nbsp;
                </th>
              </tr>
              {/* Column label row */}
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-3 py-2 font-semibold text-gray-500 whitespace-nowrap w-6">#</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600 whitespace-nowrap">FG Code Request</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600 whitespace-nowrap">SFG Material Code</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600 whitespace-nowrap">SFG1 Material Code</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Item Description | Material</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600 whitespace-nowrap">Source Line</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600 whitespace-nowrap">Target Line</th>
                <th className="text-right px-3 py-2 font-semibold text-gray-600 whitespace-nowrap">% Split</th>
                <th className="text-right px-3 py-2 font-semibold text-gray-600 whitespace-nowrap">Batch Size</th>
                <th className="text-center px-3 py-2 font-semibold text-gray-600">Active</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Remarks</th>
                <th className="text-center px-3 py-2 font-semibold text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={12} className="text-center py-12 text-gray-400">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={12} className="text-center py-12 text-gray-400">
                  {search ? "No rules match your search." : "No rules configured yet. Click \"Add Rule\" to get started."}
                </td></tr>
              ) : filtered.map((rule, idx) => {
                const active = rule.is_active === true || rule.is_active === "true";
                return (
                  <tr
                    key={rule.id}
                    className={`border-b border-gray-100 hover:bg-gray-50 transition-colors ${!active ? "opacity-50" : ""}`}
                    data-testid={`row-powermix-rule-${rule.id}`}
                  >
                    <td className="px-3 py-2.5 text-gray-400 font-medium">{idx + 1}</td>
                    <td className="px-3 py-2.5 text-gray-800 whitespace-nowrap">{rule.fg_code}</td>
                    <td className="px-3 py-2.5 text-gray-800 whitespace-nowrap">{rule.sfg_material_code}</td>
                    <td className="px-3 py-2.5 text-gray-800 whitespace-nowrap">{rule.sfg1_material_code || "—"}</td>
                    <td className="px-3 py-2.5 text-gray-800 font-medium max-w-[220px]">
                      <span className="line-clamp-2">{rule.fg_description || "—"}</span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <Badge variant="outline" className="text-[11px] font-medium border-purple-200 text-purple-700 bg-purple-50 dark:!bg-purple-50 dark:!border-purple-200 dark:!text-purple-700">
                        {rule.source_line || "Line 5"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <Badge variant="outline" className="text-[11px] font-medium border-blue-200 text-blue-700 bg-blue-50">
                        {rule.target_line}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 text-right font-bold text-[var(--nexfeed-primary)] whitespace-nowrap pm-split-value">
                      {parseFloat(rule.percentage)}%
                    </td>
                    <td className="px-3 py-2.5 text-right text-gray-700 whitespace-nowrap">{rule.batch_size}</td>
                    <td className="px-3 py-2.5 text-center">
                      <button
                        onClick={() => toggleMutation.mutate({ id: rule.id, ...rule, is_active: !active })}
                        className={`inline-flex items-center justify-center w-9 h-5 rounded-full transition-colors ${active ? "bg-green-500 hover:bg-green-600" : "bg-gray-200 hover:bg-gray-300"}`}
                        title={active ? "Click to deactivate" : "Click to activate"}
                        data-testid={`toggle-rule-${rule.id}`}
                      >
                        <span className={`w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${active ? "translate-x-2" : "-translate-x-2"}`} />
                      </button>
                    </td>
                    <td className="px-3 py-2.5 text-gray-400 max-w-[140px]">
                      <span className="line-clamp-2">{rule.remarks || "—"}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => openEdit(rule)}
                          className="p-1.5 rounded hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition-colors"
                          title="Edit rule"
                          data-testid={`button-edit-rule-${rule.id}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setDeleteTarget(rule)}
                          className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                          title="Delete rule"
                          data-testid={`button-delete-rule-${rule.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>{/* end white card */}

      {/* ── How it works ── */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-[11px] text-amber-800 space-y-1.5" data-tour="powermix-split-how-it-works">
        <p className="font-semibold flex items-center gap-1.5">
          <GitBranch className="h-3.5 w-3.5" /> How it works
        </p>
        <ul className="space-y-1 list-disc pl-4 text-amber-700">
          <li>When a <strong>Line 5</strong> or <strong>Line 7</strong> order's FG Code matches an active rule for that source line, a linked order is automatically created on the configured target line.</li>
          <li>Generated quantity = Original Volume × Percentage / 100 (rounded up to the nearest batch size).</li>
          <li>For <strong>Line 5</strong> source orders: generated order copies FG + SFG1 from the source. For <strong>Line 7</strong> source orders: generated order copies FG + SFG from the source.</li>
          <li>Click <strong>Apply Rules Now</strong> to evaluate all current Line 5 and Line 7 orders against active rules.</li>
          <li>Rules are also applied automatically when new orders are uploaded.</li>
          <li>Deactivating a rule will cancel any generated orders linked to it on next apply.</li>
        </ul>
      </div>

      {/* ── Add / Edit Dialog ── */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <GitBranch className="h-5 w-5 text-[var(--nexfeed-primary)]" />
              {editingRule ? "Edit Powermix Split Rule" : "Add Powermix Split Rule"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-5 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-sm font-medium text-gray-700">FG Code (Line 5) <span className="text-red-500">*</span></Label>
                <Input
                  value={form.fg_code}
                  onChange={(e) => setForm((f) => ({ ...f, fg_code: e.target.value }))}
                  placeholder="e.g. 1000000000039"
                  className={`text-sm h-10 font-mono ${formErrors.fg_code ? "border-red-400" : ""}`}
                  data-testid="input-fg-code"
                />
                {formErrors.fg_code && <p className="text-xs text-red-500">{formErrors.fg_code}</p>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-medium text-gray-700">Item Description | Material</Label>
                <Input
                  value={form.fg_description}
                  onChange={(e) => setForm((f) => ({ ...f, fg_description: e.target.value }))}
                  placeholder="e.g. Gallimax 2 plus"
                  className="text-sm h-10"
                  data-testid="input-fg-description"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-sm font-medium text-gray-700">SFG Material Code <span className="text-red-500">*</span></Label>
                <Input
                  value={form.sfg_material_code}
                  onChange={(e) => setForm((f) => ({ ...f, sfg_material_code: e.target.value }))}
                  placeholder="e.g. 3000000000248"
                  className={`text-sm h-10 font-mono ${formErrors.sfg_material_code ? "border-red-400" : ""}`}
                  data-testid="input-sfg-material-code"
                />
                {formErrors.sfg_material_code && <p className="text-xs text-red-500">{formErrors.sfg_material_code}</p>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-medium text-gray-700">SFG1 Material Code</Label>
                <Input
                  value={form.sfg1_material_code}
                  onChange={(e) => setForm((f) => ({ ...f, sfg1_material_code: e.target.value }))}
                  placeholder="e.g. 3000000000248"
                  className="text-sm h-10 font-mono"
                  data-testid="input-sfg1-material-code"
                />
              </div>
            </div>

            <div className="grid grid-cols-4 gap-4">
              <div className="space-y-1.5">
                <Label className="text-sm font-medium text-gray-700">Source Line <span className="text-red-500">*</span></Label>
                <Select value={form.source_line} onValueChange={(v) => setForm((f) => ({ ...f, source_line: v }))}>
                  <SelectTrigger className="text-sm h-10" data-testid="select-source-line">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SOURCE_LINES.map((l) => <SelectItem key={l} value={l} className="text-sm">{l}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-medium text-gray-700">Target Line <span className="text-red-500">*</span></Label>
                <Select value={form.target_line} onValueChange={(v) => setForm((f) => ({ ...f, target_line: v }))}>
                  <SelectTrigger className={`text-sm h-10 ${formErrors.target_line ? "border-red-400" : ""}`} data-testid="select-target-line">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TARGET_LINES.map((l) => <SelectItem key={l} value={l} className="text-sm">{l}</SelectItem>)}
                  </SelectContent>
                </Select>
                {formErrors.target_line && <p className="text-xs text-red-500">{formErrors.target_line}</p>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-medium text-gray-700">Split % <span className="text-red-500">*</span></Label>
                <Input
                  type="number" min="1" max="100" step="0.01"
                  value={form.percentage}
                  onChange={(e) => setForm((f) => ({ ...f, percentage: e.target.value }))}
                  placeholder="e.g. 85"
                  className={`text-sm h-10 ${formErrors.percentage ? "border-red-400" : ""}`}
                  data-testid="input-percentage"
                />
                {formErrors.percentage && <p className="text-xs text-red-500">{formErrors.percentage}</p>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-medium text-gray-700">Batch Size <span className="text-red-500">*</span></Label>
                <Input
                  type="number" min="1"
                  value={form.batch_size}
                  onChange={(e) => setForm((f) => ({ ...f, batch_size: e.target.value }))}
                  placeholder="e.g. 4"
                  className={`text-sm h-10 ${formErrors.batch_size ? "border-red-400" : ""}`}
                  data-testid="input-batch-size"
                />
                {formErrors.batch_size && <p className="text-xs text-red-500">{formErrors.batch_size}</p>}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm font-medium text-gray-700">Remarks</Label>
              <Input
                value={form.remarks}
                onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
                placeholder="Optional notes…"
                className="text-sm h-10"
                data-testid="input-remarks"
              />
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setForm((f) => ({ ...f, is_active: !f.is_active }))}
                className={`inline-flex items-center justify-center w-12 h-6 rounded-full transition-colors ${form.is_active ? "bg-green-500" : "bg-gray-200"}`}
                data-testid="toggle-rule-active"
              >
                <span className={`w-4 h-4 rounded-full bg-white shadow transition-transform ${form.is_active ? "translate-x-3" : "-translate-x-3"}`} />
              </button>
              <Label
                className="text-sm font-medium text-gray-700 cursor-pointer"
                onClick={() => setForm((f) => ({ ...f, is_active: !f.is_active }))}
              >
                {form.is_active ? "Active — rule will generate orders" : "Inactive — rule is disabled"}
              </Label>
            </div>

            {form.fg_code && form.percentage && !isNaN(parseFloat(form.percentage)) && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
                <p className="font-semibold mb-1">Preview:</p>
                <p>If a Line 5 order for FG <strong className="font-mono">{form.fg_code}</strong> has 100 MT volume,</p>
                <p>→ a linked order on <strong>{form.target_line}</strong> will be created with <strong>{(100 * parseFloat(form.percentage) / 100).toFixed(2)} MT</strong> (batch: {form.batch_size}).</p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button
              onClick={handleSave}
              disabled={createMutation.isPending || updateMutation.isPending}
              className="bg-[var(--nexfeed-primary)] hover:opacity-90 text-white"
              data-testid="button-save-rule"
            >
              {(createMutation.isPending || updateMutation.isPending) ? "Saving…" : editingRule ? "Save Changes" : "Create Rule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirm ── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Rule?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the split rule for FG <strong>{deleteTarget?.fg_code}</strong>
              {deleteTarget?.fg_description ? ` (${deleteTarget.fg_description})` : ""}. Any generated orders linked to this rule will not be automatically cancelled — run Apply Rules Now afterwards to clean up.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate(deleteTarget.id)}
              className="bg-red-600 hover:bg-red-700"
              data-testid="button-confirm-delete-rule"
            >
              Delete Rule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </CardContent>
    </Card>
  );
}
