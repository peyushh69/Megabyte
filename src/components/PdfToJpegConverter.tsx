import React, { useState, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import { Upload, Download, Check, Trash2, FileText, RotateCcw } from 'lucide-react';
import { formatBytes } from '../App';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface RenderedPdfPage {
  pageNumber: number; // Original 1-based page number in the source PDF
  blob: Blob;
  objectUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
  selected: boolean;
}

const SCALE_OPTIONS: { value: number; label: string }[] = [
  { value: 3.0, label: '300 DPI (ORIGINAL HD)' },
  { value: 4.0, label: '400 DPI (ULTRA 4K)' },
  { value: 2.0, label: '200 DPI (STANDARD)' },
];

export const PdfToJpegConverter: React.FC = () => {
  const [pdfFileName, setPdfFileName] = useState<string | null>(null);
  const [allOriginalPages, setAllOriginalPages] = useState<RenderedPdfPage[]>([]);
  const [pages, setPages] = useState<RenderedPdfPage[]>([]);
  const [renderScale, setRenderScale] = useState<number>(3.0);
  const [isRendering, setIsRendering] = useState<boolean>(false);
  const [renderProgress, setRenderProgress] = useState<{ current: number; total: number }>({
    current: 0,
    total: 0,
  });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isZipping, setIsZipping] = useState<boolean>(false);
  const [isExportingPdf, setIsExportingPdf] = useState<boolean>(false);

  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const currentPdfFileRef = useRef<File | null>(null);
  const originalPdfBytesRef = useRef<ArrayBuffer | null>(null);

  const cleanupPageUrls = (list: RenderedPdfPage[]) => {
    for (const p of list) {
      try {
        URL.revokeObjectURL(p.objectUrl);
      } catch {
        // ignore
      }
    }
  };

  const processPdfFile = async (file: File, scaleToUse: number) => {
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      setErrorMessage('PLEASE SELECT A VALID PDF FILE.');
      return;
    }

    setErrorMessage(null);
    setIsRendering(true);
    setPdfFileName(file.name.replace(/\.pdf$/i, ''));
    currentPdfFileRef.current = file;

    cleanupPageUrls(allOriginalPages);
    setAllOriginalPages([]);
    setPages([]);

    try {
      const rawBuffer = await file.arrayBuffer();
      // Keep a clean copy of the original PDF bytes for lossless PDF page removal/export
      originalPdfBytesRef.current = rawBuffer.slice(0);

      const loadingTask = pdfjsLib.getDocument({ data: rawBuffer.slice(0) });
      const pdfDoc = await loadingTask.promise;
      const totalPages = pdfDoc.numPages;

      setRenderProgress({ current: 0, total: totalPages });
      const renderedList: RenderedPdfPage[] = [];

      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: scaleToUse });

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { alpha: false });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);

        if (!ctx) {
          throw new Error('Canvas context unavailable');
        }

        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        await page.render({
          canvasContext: ctx,
          viewport,
          canvas,
        }).promise;

        const jpegBlob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (b) => {
              if (b) resolve(b);
              else reject(new Error('Failed to encode high-resolution JPEG'));
            },
            'image/jpeg',
            1.0 // 100% Uncompressed Maximum JPEG Quality
          );
        });

        const objectUrl = URL.createObjectURL(jpegBlob);
        const newPageItem: RenderedPdfPage = {
          pageNumber: pageNum,
          blob: jpegBlob,
          objectUrl,
          width: canvas.width,
          height: canvas.height,
          sizeBytes: jpegBlob.size,
          selected: false,
        };

        renderedList.push(newPageItem);
        setAllOriginalPages([...renderedList]);
        setPages([...renderedList]);
        setRenderProgress({ current: pageNum, total: totalPages });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'FAILED TO RENDER PDF.';
      setErrorMessage(msg.toUpperCase());
    } finally {
      setIsRendering(false);
    }
  };

  const handleScaleChange = (newScale: number) => {
    setRenderScale(newScale);
    if (currentPdfFileRef.current && !isRendering) {
      processPdfFile(currentPdfFileRef.current, newScale);
    }
  };

  const togglePageSelection = (pageNumber: number) => {
    setPages((prev) =>
      prev.map((p) => (p.pageNumber === pageNumber ? { ...p, selected: !p.selected } : p))
    );
  };

  const selectAllPages = () => {
    setPages((prev) => prev.map((p) => ({ ...p, selected: true })));
  };

  const deselectAllPages = () => {
    setPages((prev) => prev.map((p) => ({ ...p, selected: false })));
  };

  const deleteSinglePage = (pageNumber: number) => {
    setPages((prev) => prev.filter((p) => p.pageNumber !== pageNumber));
  };

  const deleteSelectedPages = () => {
    setPages((prev) => prev.filter((p) => !p.selected));
  };

  const restoreAllDeletedPages = () => {
    setPages(allOriginalPages.map((p) => ({ ...p, selected: false })));
  };

  const downloadUpdatedPdf = async () => {
    if (!originalPdfBytesRef.current || pages.length === 0) return;

    setIsExportingPdf(true);
    setErrorMessage(null);
    try {
      const srcDoc = await PDFDocument.load(originalPdfBytesRef.current);
      const newDoc = await PDFDocument.create();

      // Copy only remaining pages in their exact order (0-based indices)
      const zeroBasedIndices = pages.map((p) => p.pageNumber - 1);
      const copiedPages = await newDoc.copyPages(srcDoc, zeroBasedIndices);
      for (const cp of copiedPages) {
        newDoc.addPage(cp);
      }

      const pdfBytes = await newDoc.save();
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const baseName = pdfFileName || 'document';
      const isModified = pages.length !== allOriginalPages.length;

      const link = document.createElement('a');
      link.href = url;
      link.download = isModified ? `${baseName}-edited.pdf` : `${baseName}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'FAILED TO EXPORT PDF.';
      setErrorMessage(msg.toUpperCase());
    } finally {
      setIsExportingPdf(false);
    }
  };

  const downloadSinglePageJpeg = (page: RenderedPdfPage) => {
    const baseName = pdfFileName || 'document';
    const paddedNum = String(page.pageNumber).padStart(2, '0');
    const link = document.createElement('a');
    link.href = page.objectUrl;
    link.download = `${baseName}-page-${paddedNum}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const downloadSelectedJpegs = async () => {
    const targetPages = pages.filter((p) => p.selected);
    const listToDownload = targetPages.length > 0 ? targetPages : pages;
    if (listToDownload.length === 0) return;

    if (listToDownload.length === 1) {
      downloadSinglePageJpeg(listToDownload[0]);
      return;
    }

    for (let i = 0; i < listToDownload.length; i++) {
      downloadSinglePageJpeg(listToDownload[i]);
      if (i < listToDownload.length - 1) {
        await new Promise((r) => setTimeout(r, 180));
      }
    }
  };

  const downloadJpegsAsZip = async () => {
    const targetPages = pages.filter((p) => p.selected);
    const listToZip = targetPages.length > 0 ? targetPages : pages;
    if (listToZip.length === 0) return;

    setIsZipping(true);
    try {
      const zip = new JSZip();
      const baseName = pdfFileName || 'document';

      for (const page of listToZip) {
        const paddedNum = String(page.pageNumber).padStart(2, '0');
        zip.file(`${baseName}-page-${paddedNum}.jpg`, page.blob, {
          compression: 'STORE', // Zero compression to keep 100% original JPEG quality
        });
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const zipUrl = URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = zipUrl;
      link.download = `${baseName}-pages-jpeg.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(zipUrl), 10000);
    } finally {
      setIsZipping(false);
    }
  };

  const handleResetPdf = () => {
    cleanupPageUrls(allOriginalPages);
    setAllOriginalPages([]);
    setPages([]);
    setPdfFileName(null);
    setErrorMessage(null);
    currentPdfFileRef.current = null;
    originalPdfBytesRef.current = null;
    if (pdfInputRef.current) {
      pdfInputRef.current.value = '';
    }
  };

  const selectedCount = pages.filter((p) => p.selected).length;
  const deletedCount = allOriginalPages.length - pages.length;

  return (
    <section id="pdf-converter" className="pt-6 space-y-5 border-t-2 border-[#111111]">
      {/* Section Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b-2 border-[#111111] pb-3">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center justify-center bg-[#FF3B00] text-[#111111] border border-[#111111] px-2.5 py-1 text-xs font-bold tracking-widest">
            PDF STUDIO
          </span>
          <h2 className="text-lg sm:text-xl font-bold tracking-widest text-[#111111]">
            PDF TO JPEG &amp; PAGE REMOVER
          </h2>
        </div>

        <div className="flex items-center gap-2 text-xs font-bold">
          <span>JPEG QUALITY:</span>
          <select
            value={renderScale}
            onChange={(e) => handleScaleChange(Number(e.target.value))}
            disabled={isRendering}
            aria-label="JPEG Resolution Quality"
            className="px-2.5 py-1 text-xs font-bold bg-white border border-[#111111] text-[#111111] focus:outline-none cursor-pointer"
          >
            {SCALE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <input
        ref={pdfInputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            processPdfFile(file, renderScale);
          }
        }}
      />

      {/* Upload Box when no PDF is loaded */}
      {allOriginalPages.length === 0 && !isRendering && (
        <div className="bg-[#FF3B00] text-[#111111] border border-[#111111] p-6 sm:p-8">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setIsDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file) {
                processPdfFile(file, renderScale);
              }
            }}
            onClick={() => pdfInputRef.current?.click()}
            className={`border-2 border-[#111111] p-8 sm:p-10 transition-colors cursor-pointer flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 ${
              isDragging
                ? 'bg-[#EAE8E3] text-[#111111]'
                : 'bg-[#FF3B00] hover:bg-[#EAE8E3]/25'
            }`}
          >
            <div className="space-y-1">
              <p className="text-2xl sm:text-3xl font-bold tracking-widest leading-none">
                SELECT OR DROP PDF FILE
              </p>
              <p className="text-xs font-bold tracking-wider opacity-85">
                DELETE UNWANTED PAGES &amp; DOWNLOAD FULL PDF OR HIGH-RES JPEG
              </p>
            </div>

            <span className="inline-flex items-center gap-2 px-5 py-3 text-xs font-bold tracking-widest bg-[#111111] text-[#EAE8E3] whitespace-nowrap shrink-0">
              <Upload className="w-4 h-4" />
              UPLOAD PDF
            </span>
          </div>

          {errorMessage && (
            <div className="mt-4 bg-[#111111] text-[#FF3B00] px-4 py-2.5 text-xs font-bold tracking-wider">
              {errorMessage}
            </div>
          )}
        </div>
      )}

      {/* Rendering Progress Bar */}
      {isRendering && (
        <div className="bg-[#111111] text-[#EAE8E3] p-5 space-y-2.5 border border-[#111111]">
          <div className="flex items-center justify-between gap-3 text-xs font-mono">
            <span className="font-bold truncate">
              LOADING PDF PAGES &gt; {pdfFileName?.toUpperCase()}.PDF
            </span>
            <span className="text-[#FF3B00] font-bold shrink-0">
              PAGE {renderProgress.current} OF {renderProgress.total}
            </span>
          </div>
          <div className="w-full h-2 bg-[#EAE8E3]/20 overflow-hidden">
            <div
              className="h-full bg-[#FF3B00] transition-all duration-100"
              style={{
                width: `${
                  renderProgress.total > 0
                    ? Math.round((renderProgress.current / renderProgress.total) * 100)
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Rendered Pages Toolbar & Interactive Grid */}
      {allOriginalPages.length > 0 && (
        <div className="space-y-5">
          {/* Action Bar */}
          <div className="bg-[#FF3B00] border border-[#111111] p-4 space-y-3">
            {/* Row 1: File Info + Selection & Page Deletion Controls */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#111111]/30 pb-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold tracking-wider text-[#111111] pr-2">
                  <FileText className="w-4 h-4" />
                  {pdfFileName?.toUpperCase()}.PDF ({pages.length} OF {allOriginalPages.length} PAGES)
                </span>

                <button
                  type="button"
                  onClick={selectAllPages}
                  className="px-2.5 py-1 text-xs font-bold bg-[#EAE8E3] text-[#111111] border border-[#111111] hover:bg-[#111111] hover:text-[#EAE8E3] transition-colors cursor-pointer"
                >
                  SELECT ALL
                </button>

                {selectedCount > 0 && (
                  <button
                    type="button"
                    onClick={deselectAllPages}
                    className="px-2.5 py-1 text-xs font-bold bg-[#EAE8E3] text-[#111111] border border-[#111111] hover:bg-[#111111] hover:text-[#EAE8E3] transition-colors cursor-pointer"
                  >
                    CLEAR SELECTION ({selectedCount})
                  </button>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {/* Delete Selected Pages from PDF */}
                <button
                  type="button"
                  onClick={deleteSelectedPages}
                  disabled={selectedCount === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold tracking-wider bg-[#111111] text-[#FF3B00] border border-[#111111] hover:bg-white hover:text-[#111111] transition-colors cursor-pointer disabled:opacity-40"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  DELETE SELECTED PAGES ({selectedCount})
                </button>

                {deletedCount > 0 && (
                  <button
                    type="button"
                    onClick={restoreAllDeletedPages}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold tracking-wider bg-[#EAE8E3] text-[#111111] border border-[#111111] hover:bg-[#111111] hover:text-[#EAE8E3] transition-colors cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    RESTORE DELETED ({deletedCount})
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleResetPdf}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold bg-[#EAE8E3] text-[#111111] border border-[#111111] hover:bg-[#111111] hover:text-[#EAE8E3] transition-colors cursor-pointer"
                >
                  CHANGE PDF
                </button>
              </div>
            </div>

            {/* Row 2: Download Full Updated PDF or Download JPEGs */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={downloadUpdatedPdf}
                  disabled={pages.length === 0 || isExportingPdf}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-bold tracking-wider bg-[#111111] text-[#EAE8E3] border border-[#111111] hover:bg-[#EAE8E3] hover:text-[#111111] transition-colors cursor-pointer disabled:opacity-40"
                >
                  <Download className="w-4 h-4" />
                  {isExportingPdf
                    ? 'BUILDING PDF...'
                    : `DOWNLOAD FULL PDF (${pages.length} PAGES)`}
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={downloadSelectedJpegs}
                  disabled={pages.length === 0}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold tracking-wider bg-[#EAE8E3] text-[#111111] border border-[#111111] hover:bg-[#111111] hover:text-[#EAE8E3] transition-colors cursor-pointer disabled:opacity-40"
                >
                  <Download className="w-3.5 h-3.5" />
                  {selectedCount > 0
                    ? `DOWNLOAD JPEG (${selectedCount})`
                    : `DOWNLOAD ALL JPEG (${pages.length})`}
                </button>

                {pages.length > 1 && (
                  <button
                    type="button"
                    onClick={downloadJpegsAsZip}
                    disabled={pages.length === 0 || isZipping}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold tracking-wider bg-[#EAE8E3] text-[#111111] border border-[#111111] hover:bg-[#111111] hover:text-[#EAE8E3] transition-colors cursor-pointer disabled:opacity-40"
                  >
                    <Download className="w-3.5 h-3.5" />
                    {isZipping
                      ? 'PACKING ZIP...'
                      : selectedCount > 0
                        ? `DOWNLOAD ZIP (${selectedCount})`
                        : `DOWNLOAD ALL ZIP (${pages.length})`}
                  </button>
                )}
              </div>
            </div>
          </div>

          {errorMessage && (
            <div className="bg-[#111111] text-[#FF3B00] px-4 py-2.5 text-xs font-bold tracking-wider">
              {errorMessage}
            </div>
          )}

          {pages.length === 0 ? (
            <div className="py-10 text-center border border-[#111111] bg-white space-y-3">
              <p className="text-sm font-bold tracking-widest text-[#111111]">
                ALL PAGES WERE REMOVED.
              </p>
              <button
                type="button"
                onClick={restoreAllDeletedPages}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold bg-[#FF3B00] text-[#111111] border border-[#111111] cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                RESTORE ALL PAGES
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-5">
              {pages.map((page, currentIdx) => (
                <div
                  key={page.pageNumber}
                  onClick={() => togglePageSelection(page.pageNumber)}
                  className={`border-2 transition-colors cursor-pointer flex flex-col justify-between bg-white ${
                    page.selected
                      ? 'border-[#111111] ring-2 ring-[#FF3B00]'
                      : 'border-[#111111] hover:border-[#FF3B00]'
                  }`}
                >
                  {/* Top Bar of Card */}
                  <div
                    className={`px-3 py-2 border-b border-[#111111] flex items-center justify-between text-xs font-bold ${
                      page.selected ? 'bg-[#FF3B00] text-[#111111]' : 'bg-[#EAE8E3] text-[#111111]'
                    }`}
                  >
                    <span>
                      PAGE {String(currentIdx + 1).padStart(2, '0')}
                      {currentIdx + 1 !== page.pageNumber
                        ? ` (ORIG #${page.pageNumber})`
                        : ''}
                    </span>
                    <span className="inline-flex items-center gap-1 font-mono">
                      {page.width}×{page.height} · {formatBytes(page.sizeBytes)}
                    </span>
                  </div>

                  {/* Page Preview Image */}
                  <div className="relative p-3 bg-[#EAE8E3]/40 flex items-center justify-center min-h-60">
                    <img
                      src={page.objectUrl}
                      alt={`Page ${page.pageNumber}`}
                      className="max-h-72 w-auto object-contain border border-[#111111]/20 shadow-xs bg-white"
                    />

                    <div
                      className={`absolute top-5 right-5 w-6 h-6 border border-[#111111] flex items-center justify-center transition-colors ${
                        page.selected ? 'bg-[#FF3B00] text-[#111111]' : 'bg-white text-transparent'
                      }`}
                    >
                      <Check className="w-4 h-4 stroke-[3]" />
                    </div>
                  </div>

                  {/* Direct Single-Page Actions Footer */}
                  <div className="p-2.5 bg-[#EAE8E3] border-t border-[#111111] flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSinglePage(page.pageNumber);
                      }}
                      title="Remove this page from PDF"
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-bold bg-white text-[#111111] hover:bg-[#111111] hover:text-[#FF3B00] border border-[#111111] transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      REMOVE
                    </button>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        downloadSinglePageJpeg(page);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold bg-[#111111] text-[#EAE8E3] hover:bg-[#FF3B00] hover:text-[#111111] border border-[#111111] transition-colors cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      JPEG
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
