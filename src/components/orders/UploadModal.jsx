import React, { useState, useCallback } from 'react';
import { Upload, FileSpreadsheet, X, Loader2 } from 'lucide-react';
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export default function UploadModal({ isOpen, onClose, onUpload, isUploading }) {
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);

  const handleDrag = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
        setSelectedFile(file);
      }
    }
  }, []);

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
    }
  };

  const handleUpload = () => {
    if (selectedFile) {
      onUpload(selectedFile);
    }
  };

  const handleClose = () => {
    setSelectedFile(null);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-[#fd5108]" />
            Upload SAP Planned Orders
          </DialogTitle>
          <DialogDescription>
            Upload an Excel file (.xlsx) containing SAP planned orders to import into the system.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-4">
          <div
            className={`border-2 border-dashed rounded-xl p-8 text-center transition-all ${
              dragActive 
                ? 'border-[#fd5108] bg-orange-50' 
                : 'border-gray-200 hover:border-gray-300'
            }`}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
          >
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileChange}
              className="hidden"
              id="file-upload"
            />
            
            {selectedFile ? (
              <div className="space-y-3">
                <div className="inline-flex items-center gap-2 bg-green-50 text-green-700 px-4 py-2 rounded-lg">
                  <FileSpreadsheet className="h-5 w-5" />
                  <span className="font-medium">{selectedFile.name}</span>
                  <button 
                    onClick={() => setSelectedFile(null)}
                    className="ml-2 hover:text-green-900"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <p className="text-sm text-gray-500">
                  {(selectedFile.size / 1024).toFixed(1)} KB
                </p>
              </div>
            ) : (
              <label htmlFor="file-upload" className="cursor-pointer">
                <Upload className="h-10 w-10 text-gray-400 mx-auto mb-3" />
                <p className="text-sm text-gray-600 mb-1">
                  <span className="text-[#fd5108] font-medium">Click to upload</span> or drag and drop
                </p>
                <p className="text-xs text-gray-400">
                  Excel files only (.xlsx, .xls)
                </p>
              </label>
            )}
          </div>

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={handleClose} disabled={isUploading}>
              Cancel
            </Button>
            <Button 
              onClick={handleUpload} 
              disabled={!selectedFile || isUploading}
              className="bg-[#fd5108] hover:bg-[#fe7c39]"
            >
              {isUploading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  Upload & Import
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}