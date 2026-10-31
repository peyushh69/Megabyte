import React, { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { X, Copy, Check } from 'lucide-react';

interface QrPairingModalProps {
  isOpen: boolean;
  onClose: () => void;
  roomId: string;
}

export const QrPairingModal: React.FC<QrPairingModalProps> = ({
  isOpen,
  onClose,
  roomId,
}) => {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const shareUrl = `${window.location.origin}/?room=${encodeURIComponent(roomId)}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#111111]/70 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-modal-title"
    >
      <div className="w-full max-w-sm bg-[#EAE8E3] border-2 border-[#111111] overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 bg-[#FF6A1A] border-b-2 border-[#111111]">
          <h3 id="qr-modal-title" className="text-sm font-bold tracking-widest text-[#111111]">
            SCAN TO OPEN ROOM
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-[#111111] hover:bg-[#111111] hover:text-[#EAE8E3] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="flex flex-col items-center text-center bg-white border border-[#111111] p-5">
            <QRCodeSVG value={shareUrl} size={168} level="M" bgColor="#FFFFFF" fgColor="#111111" />
            <p className="text-2xl font-bold font-mono tracking-widest text-[#111111] mt-4">
              {roomId}
            </p>
          </div>

          <button
            type="button"
            onClick={handleCopy}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-bold tracking-widest text-[#111111] bg-[#FF6A1A] border border-[#111111] hover:bg-[#111111] hover:text-[#EAE8E3] transition-colors cursor-pointer"
          >
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copied ? 'LINK COPIED' : 'COPY ROOM LINK'}
          </button>
        </div>
      </div>
    </div>
  );
};
