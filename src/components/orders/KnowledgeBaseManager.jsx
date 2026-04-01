import React, { useState, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import {
  Upload,
  Download,
  Database,
  RefreshCw,
  Search,
  Loader2,
  FileSpreadsheet,
  CheckCircle2,
  Trash2,
  AlertTriangle,
  Calendar,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { format } from "date-fns";
import { toast } from "sonner";

const { KnowledgeBase, KnowledgeBaseUpload } = base44.entities;

function formatUploadDate(dateStr) {
  if (!dateStr) return "-";
  try {
    const d = new Date(dateStr);
    return format(d, "MM/dd/yyyy hh:mm aa");
  } catch {
    return dateStr;
  }
}

export default function KnowledgeBaseManager({ orders, onReapply }) {
  const queryClient = useQueryClient();
  const fileRef = useRef(null);
  const [isUploading, setIsUploading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [showReapplyConfirm, setShowReapplyConfirm] = useState(false);
  const [isReapplying, setIsReapplying] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null); // { upload, isActive }
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [uploadSearch, setUploadSearch] = useState("");
  const [uploadDateFilter, setUploadDateFilter] = useState("");

  const { data: kbRecords = [] } = useQuery({
    queryKey: ["kb"],
    queryFn: () => KnowledgeBase.list("-created_date", 2000),
  });

  const { data: uploads = [] } = useQuery({
    queryKey: ["kb_uploads"],
    queryFn: () => KnowledgeBaseUpload.list("-created_date"),
  });

  // Active upload = most recent
  const activeUpload = uploads[0] || null;
  // Active KB records = those belonging to active session
  const activeKB = activeUpload
    ? kbRecords.filter(
        (r) => r.upload_session_id === activeUpload.upload_session_id,
      )
    : [];

  const filteredKB = activeKB.filter(
    (row) =>
      !searchTerm ||
      (row.fg_item_description || "")
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      (row.fg_material_code || "")
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      (row.sfg1_material_code || "")
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      (row.sfg_item_description || "")
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      (row.thread || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
      (row.sacks_item_description || "")
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      (row.tags_item_description || "")
        .toLowerCase()
        .includes(searchTerm.toLowerCase()),
  );

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploading(true);
    try {
      console.log("[KB Upload] Reading file:", file.name, file.size, "bytes");
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: "array" });
      const sheetName = workbook.SheetNames[0];
      console.log("[KB Upload] Sheet:", sheetName);
      const worksheet = workbook.Sheets[sheetName];
      const rawRows = XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        defval: "",
      });
      console.log("[KB Upload] Raw rows:", rawRows.length);

      let headerRowIdx = rawRows.findIndex((row) =>
        row.some(
          (cell) => String(cell).trim().toLowerCase() === "fg material code",
        ),
      );
      if (headerRowIdx < 0) headerRowIdx = 0;
      const headers = rawRows[headerRowIdx].map((h) => String(h).trim());
      console.log(
        "[KB Upload] Headers:",
        headers.filter((h) => h),
      );

      const KB_COLUMN_MAP = {
        "fg material code": "FG Material Code",
        "fg item description": "FG Item Description",
        "sfg1 material code": "SFG1 Material Code",
        "sfg item description": "SFG Item Description",
        diamater: "Diamater",
        diameter: "Diamater",
        form: "Form",
        "batch size fm1": "Batch Size FM1",
        "batch size fm2": "Batch Size FM2",
        "batch size fm3": "Batch Size FM3",
        "batch size pmx": "Batch Size PMX",
        "finished goods weight": "Finished Goods Weight",
        thread: "Thread",
        "sacks material code": "Sacks Material Code",
        "sacks item description": "Sacks Item Description",
        "tags material code": "Tags Material Code",
        "tags item description": "Tags Item Description",
        "label 1": "Label 1",
        "label 2": "Label 2",
        "undetermined value": "Undetermined Value",
        "line 1 run rate": "Line 1 Run Rate",
        "line 2 run rate": "Line 2 Run Rate",
        "line 3 run rate": "Line 3 Run Rate",
        "line 4 run rate": "Line 4 Run Rate",
        "line 5 run rate": "Line 5 Run Rate",
        "line 6 run rate": "Line 6 Run Rate",
        "line 7 run rate": "Line 7 Run Rate",
      };

      const colIndex = {};
      headers.forEach((h, i) => {
        const key = h.toLowerCase();
        if (KB_COLUMN_MAP[key]) {
          colIndex[KB_COLUMN_MAP[key]] = i;
        }
      });
      console.log("[KB Upload] Mapped columns:", Object.keys(colIndex));

      const dataRows = rawRows
        .slice(headerRowIdx + 1)
        .filter((row) =>
          row.some(
            (cell) => cell !== "" && cell !== null && cell !== undefined,
          ),
        );

      const excelRows = dataRows
        .map((row) => {
          const obj = {};
          for (const [field, idx] of Object.entries(colIndex)) {
            let val = row[idx];
            if (val !== null && val !== undefined) val = String(val).trim();
            obj[field] = val || "";
          }
          return obj;
        })
        .filter((r) => r["FG Material Code"]);

      console.log("[KB Upload] Parsed", excelRows.length, "valid rows");

      const sessionId = `kb_${Date.now()}`;

      const toNum = (v) => {
        if (v === "" || v === null || v === undefined) return null;
        const n = parseFloat(v);
        return isNaN(n) ? null : n;
      };

      const records = excelRows.map((r) => ({
        fg_material_code: String(r["FG Material Code"] || ""),
        fg_item_description: r["FG Item Description"] || "",
        sfg1_material_code: r["SFG1 Material Code"]
          ? String(r["SFG1 Material Code"])
          : "",
        sfg_item_description: r["SFG Item Description"] || "",
        diameter: toNum(r["Diamater"]),
        form: r["Form"] || "",
        batch_size_fm1: toNum(r["Batch Size FM1"]),
        batch_size_fm2: toNum(r["Batch Size FM2"]),
        batch_size_fm3: toNum(r["Batch Size FM3"]),
        batch_size_pmx: toNum(r["Batch Size PMX"]),
        finished_goods_weight: toNum(r["Finished Goods Weight"]),
        thread: r["Thread"] || "",
        sacks_material_code: r["Sacks Material Code"]
          ? String(r["Sacks Material Code"])
          : "",
        sacks_item_description: r["Sacks Item Description"] || "",
        tags_material_code: r["Tags Material Code"]
          ? String(r["Tags Material Code"])
          : "",
        tags_item_description: r["Tags Item Description"] || "",
        label_1: r["Label 1"] || "",
        label_2: r["Label 2"] || "",
        undetermined_value: toNum(r["Undetermined Value"]),
        line_1_run_rate: toNum(r["Line 1 Run Rate"]),
        line_2_run_rate: toNum(r["Line 2 Run Rate"]),
        line_3_run_rate: toNum(r["Line 3 Run Rate"]),
        line_4_run_rate: toNum(r["Line 4 Run Rate"]),
        line_5_run_rate: toNum(r["Line 5 Run Rate"]),
        line_6_run_rate: toNum(r["Line 6 Run Rate"]),
        line_7_run_rate: toNum(r["Line 7 Run Rate"]),
        upload_session_id: sessionId,
      }));

      console.log("[KB Upload] Saving", records.length, "records...");
      await KnowledgeBase.bulkCreate(records);
      await KnowledgeBaseUpload.create({
        filename: file.name,
        file_url: "",
        upload_session_id: sessionId,
        record_count: records.length,
        is_active: true,
      });

      queryClient.invalidateQueries({ queryKey: ["kb"] });
      queryClient.invalidateQueries({ queryKey: ["kb_uploads"] });
      console.log("[KB Upload] Success!");
      toast.success(`${records.length} products loaded in Knowledge Base.`);
    } catch (err) {
      console.error("[KB Upload] Error:", err);
      toast.error("Failed to upload Knowledge Base: " + err.message);
    }
    setIsUploading(false);
    e.target.value = "";
  };

  const handleReapply = async () => {
    if (!activeUpload || !orders?.length) return;
    setIsReapplying(true);
    setShowReapplyConfirm(false);
    try {
      await onReapply?.(activeKB);
      toast.success("Knowledge Base re-applied to all existing orders.");
    } catch (err) {
      toast.error("Re-apply failed: " + err.message);
    }
    setIsReapplying(false);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    const { upload, isActive } = deleteTarget;
    setIsDeleting(true);
    try {
      // Delete all KB records belonging to this session
      const sessionRecords = kbRecords.filter(
        (r) => r.upload_session_id === upload.upload_session_id,
      );
      await Promise.all(sessionRecords.map((r) => KnowledgeBase.delete(r.id)));
      // Delete the upload metadata
      await KnowledgeBaseUpload.delete(upload.id);
      queryClient.invalidateQueries(["kb"]);
      queryClient.invalidateQueries(["kb_uploads"]);
      setDeleteTarget(null);
      setConfirmText("");
      if (isActive) {
        toast.success(`Active file deleted: ${upload.filename}`);
      } else {
        toast.success(`File deleted: ${upload.filename}`);
      }
    } catch (err) {
      toast.error("Delete failed: " + err.message);
    }
    setIsDeleting(false);
  };

  const colHeaders = [
    { key: "fg_material_code", label: "FG Material Code", w: 150 },
    { key: "fg_item_description", label: "FG Item Description", w: 280 },
    { key: "sfg1_material_code", label: "SFG1 Material Code", w: 150 },
    { key: "sfg_item_description", label: "SFG Item Description", w: 220 },
    { key: "form", label: "Form", w: 70 },
    { key: "batch_size_fm1", label: "Batch FM1", w: 90 },
    { key: "batch_size_fm2", label: "Batch FM2", w: 90 },
    { key: "batch_size_fm3", label: "Batch FM3", w: 90 },
    { key: "batch_size_pmx", label: "Batch PMX", w: 90 },
    { key: "finished_goods_weight", label: "FG Weight", w: 90 },
    { key: "thread", label: "Thread", w: 80 },
    { key: "sacks_material_code", label: "Sacks Code", w: 130 },
    { key: "sacks_item_description", label: "Sacks Desc", w: 200 },
    { key: "tags_material_code", label: "Tags Code", w: 130 },
    { key: "tags_item_description", label: "Tags Desc", w: 200 },
    { key: "label_1", label: "Label 1", w: 100 },
    { key: "label_2", label: "Label 2", w: 100 },
    { key: "line_1_run_rate", label: "L1 Rate", w: 90 },
    { key: "line_2_run_rate", label: "L2 Rate", w: 90 },
    { key: "line_3_run_rate", label: "L3 Rate", w: 90 },
    { key: "line_4_run_rate", label: "L4 Rate", w: 90 },
    { key: "line_5_run_rate", label: "L5 Rate", w: 90 },
    { key: "line_6_run_rate", label: "L6 Rate", w: 90 },
    { key: "line_7_run_rate", label: "L7 Rate", w: 90 },
  ];

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <Database className="h-8 w-8 text-[#fd5108]" />
            <div>
              <CardTitle className="text-[16px]">Knowledge Base</CardTitle>
              <p className="text-[12px] text-gray-500 mt-0.5">
                Upload and manage master data for auto-populating order details
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {activeUpload && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowReapplyConfirm(true)}
                disabled={isReapplying}
                className="text-[10px]"
              >
                {isReapplying ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3 mr-1" />
                )}
                Re-apply to Existing Orders
              </Button>
            )}
            <Button
              size="sm"
              className="bg-[#fd5108] hover:bg-[#fe7c39] text-white text-[10px]"
              onClick={() => fileRef.current?.click()}
              disabled={isUploading}
            >
              {isUploading ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Upload className="h-3 w-3 mr-1" />
              )}
              Upload Knowledge Base
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={handleUpload}
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Active KB Table */}
        {activeKB.length > 0 ? (
          <div>
            <div className="flex items-center gap-3 mb-3">
              <div className="relative flex-1 max-w-xs">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                <Input
                  placeholder="Search by code or description..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-8 h-8 text-xs"
                />
              </div>
              <span className="text-[10px] text-gray-500">
                Showing {filteredKB.length} of {activeKB.length} products
              </span>
            </div>
            <div
              className="overflow-auto rounded-lg border border-gray-100"
              style={{ maxHeight: "calc(100vh - 420px)", minHeight: 300 }}
            >
              <table
                className="text-xs"
                style={{
                  tableLayout: "fixed",
                  width: "max-content",
                  minWidth: "100%",
                  borderCollapse: "collapse",
                }}
              >
                <thead
                  className="bg-gray-50"
                  style={{ position: "sticky", top: 0, zIndex: 10 }}
                >
                  <tr>
                    {colHeaders.map((col) => (
                      <th
                        key={col.key}
                        style={{ width: col.w, minWidth: col.w }}
                        className="px-2 py-2 text-left font-bold text-gray-600 whitespace-nowrap border-b border-gray-200"
                      >
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredKB.map((row, i) => (
                    <tr
                      key={row.id}
                      className={i % 2 === 0 ? "bg-white" : "bg-gray-50/50"}
                    >
                      {colHeaders.map((col) => {
                        const val = row[col.key];
                        const isRate = col.key.includes("run_rate");
                        const display =
                          val == null || val === ""
                            ? "-"
                            : isRate
                              ? parseFloat(val).toFixed(2)
                              : String(val);
                        return (
                          <td
                            key={col.key}
                            style={{ width: col.w, maxWidth: col.w }}
                            className="px-2 py-1.5 text-gray-700 border-b border-gray-50 truncate whitespace-nowrap overflow-hidden"
                          >
                            {display}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-10 text-gray-400 border border-dashed border-gray-200 rounded-lg">
            <Database className="h-8 w-8 mb-2 opacity-40" />
            <p className="text-sm">No Knowledge Base uploaded yet</p>
            <p className="text-xs mt-1">
              Upload an Excel file to enable auto-population of order fields
            </p>
          </div>
        )}

        {/* Upload History */}
        <div style={{ marginTop: 16 }}>
          <h4
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "#1a1a1a",
              marginBottom: 8,
            }}
          >
            Upload History
          </h4>
          {uploads.length === 0 ? (
            <p
              style={{
                fontSize: 10,
                color: "#9ca3af",
                fontStyle: "italic",
                textAlign: "center",
                padding: "12px 0",
              }}
            >
              No uploads yet. Upload a file to get started.
            </p>
          ) : (
            (() => {
              const filteredUploads = uploads.filter((u) => {
                const nameMatch =
                  !uploadSearch ||
                  (u.filename || "")
                    .toLowerCase()
                    .includes(uploadSearch.toLowerCase());
                const dateMatch =
                  !uploadDateFilter ||
                  (u.created_date || "").startsWith(uploadDateFilter);
                return nameMatch && dateMatch;
              });
              return (
                <>
                  {/* Search + Date filter bar */}
                  <div
                    className="flex items-center gap-2 flex-wrap"
                    style={{ marginBottom: 8 }}
                  >
                    {/* Search */}
                    <div style={{ position: "relative", width: 200 }}>
                      <Search
                        style={{
                          position: "absolute",
                          left: 7,
                          top: "50%",
                          transform: "translateY(-50%)",
                          width: 11,
                          height: 11,
                          color: "#9ca3af",
                          pointerEvents: "none",
                        }}
                      />
                      <input
                        type="text"
                        value={uploadSearch}
                        onChange={(e) => setUploadSearch(e.target.value)}
                        placeholder="Search by filename..."
                        data-testid="input-kb-upload-search"
                        style={{
                          width: "100%",
                          paddingLeft: 24,
                          paddingRight: 6,
                          paddingTop: 4,
                          paddingBottom: 4,
                          fontSize: 10,
                          border: "1px solid #d1d5db",
                          borderRadius: 4,
                          outline: "none",
                          color: "#374151",
                        }}
                        onFocus={(e) =>
                          (e.target.style.borderColor = "#fd5108")
                        }
                        onBlur={(e) => (e.target.style.borderColor = "#d1d5db")}
                      />
                    </div>
                    {/* Date filter */}
                    <div style={{ position: "relative", width: 160 }}>
                      <Calendar
                        style={{
                          position: "absolute",
                          left: 7,
                          top: "50%",
                          transform: "translateY(-50%)",
                          width: 11,
                          height: 11,
                          color: "#9ca3af",
                          pointerEvents: "none",
                        }}
                      />
                      <input
                        type="date"
                        value={uploadDateFilter}
                        onChange={(e) => setUploadDateFilter(e.target.value)}
                        data-testid="input-kb-upload-date"
                        style={{
                          width: "100%",
                          paddingLeft: 24,
                          paddingRight: 6,
                          paddingTop: 4,
                          paddingBottom: 4,
                          fontSize: 10,
                          border: "1px solid #d1d5db",
                          borderRadius: 4,
                          outline: "none",
                          color: uploadDateFilter ? "#374151" : "#9ca3af",
                        }}
                        onFocus={(e) =>
                          (e.target.style.borderColor = "#fd5108")
                        }
                        onBlur={(e) => (e.target.style.borderColor = "#d1d5db")}
                      />
                    </div>
                    {/* Count */}
                    <span
                      style={{
                        fontSize: 10,
                        color: "#6B7280",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Showing {filteredUploads.length} of {uploads.length}{" "}
                      upload{uploads.length !== 1 ? "s" : ""}
                    </span>
                  </div>

                  {/* Table */}
                  <div
                    style={{
                      maxHeight: 200,
                      overflowY: "auto",
                      border: "1px solid #e5e7eb",
                      borderRadius: 4,
                    }}
                  >
                    <table
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        tableLayout: "fixed",
                      }}
                    >
                      <colgroup>
                        <col style={{ width: 36 }} />
                        <col style={{ width: "35%" }} />
                        <col style={{ width: "25%" }} />
                        <col style={{ width: "10%" }} />
                        <col style={{ width: "10%" }} />
                        <col style={{ width: "10%" }} />
                      </colgroup>
                      <thead
                        style={{
                          position: "sticky",
                          top: 0,
                          background: "#fff",
                          zIndex: 1,
                        }}
                      >
                        <tr style={{ borderBottom: "1px solid #e5e7eb" }}>
                          {[
                            "#",
                            "FILE NAME",
                            "UPLOAD DATE",
                            "RECORDS",
                            "STATUS",
                            "ACTIONS",
                          ].map((col) => (
                            <th
                              key={col}
                              style={{
                                fontSize: 9,
                                fontWeight: 600,
                                color: "#6b7280",
                                letterSpacing: "0.5px",
                                padding: "6px 10px",
                                textAlign:
                                  col === "#" ||
                                  col === "RECORDS" ||
                                  col === "STATUS" ||
                                  col === "ACTIONS"
                                    ? "center"
                                    : "left",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredUploads.length === 0 ? (
                          <tr>
                            <td
                              colSpan={6}
                              style={{
                                fontSize: 10,
                                color: "#9ca3af",
                                fontStyle: "italic",
                                textAlign: "center",
                                padding: "12px 0",
                              }}
                            >
                              No uploads match your search.
                            </td>
                          </tr>
                        ) : (
                          filteredUploads.map((u, i) => {
                            const isActive = uploads[0]?.id === u.id;
                            return (
                              <tr
                                key={u.id}
                                style={{
                                  borderBottom: "1px solid #f3f4f6",
                                  background: "#fff",
                                }}
                                onMouseEnter={(e) =>
                                  (e.currentTarget.style.background = "#fafafa")
                                }
                                onMouseLeave={(e) =>
                                  (e.currentTarget.style.background = "#fff")
                                }
                                data-testid={`row-kb-upload-${i}`}
                              >
                                {/* # */}
                                <td
                                  style={{
                                    fontSize: 10,
                                    color: "#6b7280",
                                    padding: "6px 10px",
                                    textAlign: "center",
                                  }}
                                >
                                  {i + 1}
                                </td>
                                {/* File Name */}
                                <td
                                  style={{
                                    fontSize: 10,
                                    fontWeight: 500,
                                    color: "#1a1a1a",
                                    padding: "6px 10px",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                  title={u.filename}
                                >
                                  {u.filename}
                                </td>
                                {/* Upload Date */}
                                <td
                                  style={{
                                    fontSize: 10,
                                    color: "#6b7280",
                                    padding: "6px 10px",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {formatUploadDate(u.created_date)}
                                </td>
                                {/* Records */}
                                <td
                                  style={{
                                    fontSize: 10,
                                    color: "#6b7280",
                                    padding: "6px 10px",
                                    textAlign: "center",
                                  }}
                                >
                                  {u.record_count ?? "?"}
                                </td>
                                {/* Status */}
                                <td
                                  style={{
                                    padding: "6px 10px",
                                    textAlign: "center",
                                  }}
                                >
                                  {isActive && (
                                    <span
                                      style={{
                                        fontSize: 9,
                                        fontWeight: 600,
                                        color: "#43a047",
                                        background: "#dcfce7",
                                        padding: "2px 6px",
                                        borderRadius: 3,
                                      }}
                                    >
                                      Active
                                    </span>
                                  )}
                                </td>
                                {/* Actions */}
                                <td
                                  style={{
                                    padding: "6px 10px",
                                    textAlign: "center",
                                  }}
                                >
                                  <div
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: 8,
                                    }}
                                  >
                                    {u.file_url ? (
                                      <a
                                        href={u.file_url}
                                        download={u.filename}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        title="Download file"
                                        style={{
                                          color: "#9ca3af",
                                          lineHeight: 1,
                                        }}
                                        onMouseEnter={(e) =>
                                          (e.currentTarget.style.color =
                                            "#fd5108")
                                        }
                                        onMouseLeave={(e) =>
                                          (e.currentTarget.style.color =
                                            "#9ca3af")
                                        }
                                        data-testid={`button-download-kb-upload-${i}`}
                                      >
                                        <Download
                                          style={{ width: 12, height: 12 }}
                                        />
                                      </a>
                                    ) : (
                                      <span
                                        style={{
                                          color: "#d1d5db",
                                          lineHeight: 1,
                                        }}
                                        title="Download not available"
                                      >
                                        <Download
                                          style={{ width: 12, height: 12 }}
                                        />
                                      </span>
                                    )}
                                    <button
                                      onClick={() =>
                                        setDeleteTarget({ upload: u, isActive })
                                      }
                                      title="Delete upload"
                                      style={{
                                        color: "#9ca3af",
                                        background: "none",
                                        border: "none",
                                        cursor: "pointer",
                                        padding: 0,
                                        lineHeight: 1,
                                      }}
                                      onMouseEnter={(e) =>
                                        (e.currentTarget.style.color =
                                          "#e53935")
                                      }
                                      onMouseLeave={(e) =>
                                        (e.currentTarget.style.color =
                                          "#9ca3af")
                                      }
                                      data-testid={`button-delete-kb-upload-${i}`}
                                    >
                                      <Trash2
                                        style={{ width: 12, height: 12 }}
                                      />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              );
            })()
          )}
        </div>
      </CardContent>

      {/* Re-apply confirmation */}
      <AlertDialog
        open={showReapplyConfirm}
        onOpenChange={setShowReapplyConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-apply Knowledge Base</AlertDialogTitle>
            <AlertDialogDescription>
              This will update Form, Batch Size, and Run Rate for all existing
              orders based on the current Knowledge Base. User-edited values
              will be overwritten. Proceed?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleReapply}
              className="bg-[#fd5108] hover:bg-[#fe7c39] text-white"
            >
              Re-apply
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* Delete confirmation dialog */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !isDeleting) {
            setDeleteTarget(null);
            setConfirmText("");
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogTitle className="sr-only">Delete Upload</DialogTitle>
          {deleteTarget &&
            (() => {
              const { upload, isActive } = deleteTarget;
              const isExact = confirmText === "Confirm";
              const isPartial =
                !isExact &&
                confirmText.length > 0 &&
                "Confirm".startsWith(confirmText);
              const isWrong = !isExact && !isPartial && confirmText.length > 0;
              const canDelete = isExact && !isDeleting;
              const inputBorderColor = isExact
                ? "#43a047"
                : isWrong
                  ? "#fecaca"
                  : "#d1d5db";
              return (
                <div>
                  {/* Title */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 10,
                    }}
                  >
                    <Trash2
                      style={{
                        width: 15,
                        height: 15,
                        color: "#e53935",
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: "#1a1a1a",
                      }}
                    >
                      Delete Upload
                    </span>
                  </div>
                  <p
                    style={{ fontSize: 12, color: "#6b7280", marginBottom: 14 }}
                  >
                    Are you sure you want to delete this file?
                  </p>

                  {/* File details */}
                  <div style={{ marginBottom: 14 }}>
                    {[
                      ["File", upload.filename],
                      ["Uploaded", formatUploadDate(upload.created_date)],
                      ["Records", `${upload.record_count ?? "?"} records`],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        style={{ display: "flex", gap: 8, marginBottom: 3 }}
                      >
                        <span
                          style={{
                            fontSize: 11,
                            color: "#6b7280",
                            minWidth: 78,
                          }}
                        >
                          {label}:
                        </span>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 500,
                            color: "#1a1a1a",
                          }}
                        >
                          {value}
                        </span>
                      </div>
                    ))}
                    {isActive && (
                      <div style={{ display: "flex", gap: 8, marginBottom: 3 }}>
                        <span
                          style={{
                            fontSize: 11,
                            color: "#6b7280",
                            minWidth: 78,
                          }}
                        >
                          Status:
                        </span>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: "#43a047",
                          }}
                        >
                          Active ✓
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Warning */}
                  <div
                    style={{
                      background: "#fef2f2",
                      border: "1px solid #fecaca",
                      borderRadius: 6,
                      padding: "8px 12px",
                      marginBottom: 14,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                      }}
                    >
                      <AlertTriangle
                        style={{
                          width: 13,
                          height: 13,
                          color: "#e53935",
                          marginTop: 1,
                          flexShrink: 0,
                        }}
                      />
                      <p
                        style={{
                          fontSize: 11,
                          color: "#991b1b",
                          lineHeight: 1.5,
                        }}
                      >
                        {isActive ? (
                          <>
                            <strong>This is the currently ACTIVE file.</strong>{" "}
                            Deleting it will remove all associated data. The
                            next most recent upload will become active, or the
                            page will revert to empty state if no other uploads
                            exist. This action cannot be undone.
                          </>
                        ) : (
                          "This action cannot be undone. The file and its data will be permanently removed."
                        )}
                      </p>
                    </div>
                  </div>

                  {/* Confirm input */}
                  <div style={{ marginBottom: 18 }}>
                    <label
                      style={{
                        display: "block",
                        fontSize: 12,
                        fontWeight: 500,
                        color: "#1a1a1a",
                        marginBottom: 6,
                      }}
                    >
                      Type <em>"Confirm"</em> to proceed:
                    </label>
                    <input
                      autoFocus
                      type="text"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && canDelete)
                          handleConfirmDelete();
                      }}
                      placeholder="Type Confirm here..."
                      disabled={isDeleting}
                      data-testid="input-delete-confirm"
                      style={{
                        width: "100%",
                        padding: "6px 10px",
                        fontSize: 12,
                        border: `1px solid ${inputBorderColor}`,
                        borderRadius: 6,
                        outline: "none",
                        color: "#374151",
                        fontStyle: confirmText ? "normal" : "italic",
                      }}
                    />
                    {isWrong && (
                      <p
                        style={{ fontSize: 10, color: "#e53935", marginTop: 4 }}
                      >
                        Please type 'Confirm' exactly.
                      </p>
                    )}
                  </div>

                  {/* Buttons */}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      gap: 8,
                    }}
                  >
                    <button
                      onClick={() => {
                        setDeleteTarget(null);
                        setConfirmText("");
                      }}
                      disabled={isDeleting}
                      style={{
                        fontSize: 12,
                        color: "#374151",
                        padding: "6px 16px",
                        border: "1px solid #d1d5db",
                        borderRadius: 6,
                        background: "none",
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.borderColor = "#9ca3af")
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.borderColor = "#d1d5db")
                      }
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleConfirmDelete}
                      disabled={!canDelete}
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        padding: "6px 16px",
                        border: "none",
                        borderRadius: 6,
                        color: canDelete ? "#fff" : "#d1d5db",
                        background: isDeleting
                          ? "#f87171"
                          : canDelete
                            ? "#e53935"
                            : "#f3f4f6",
                        cursor: canDelete ? "pointer" : "not-allowed",
                      }}
                      onMouseEnter={(e) => {
                        if (canDelete)
                          e.currentTarget.style.background = "#c62828";
                      }}
                      onMouseLeave={(e) => {
                        if (canDelete && !isDeleting)
                          e.currentTarget.style.background = "#e53935";
                      }}
                    >
                      {isDeleting ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </div>
              );
            })()}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
