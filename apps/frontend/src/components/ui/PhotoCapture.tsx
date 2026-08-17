'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, Upload, RotateCcw, X, ImageOff } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from './Button';

/**
 * Camera-first photo capture with a file-picker fallback — the "wajib foto"
 * component used everywhere the PRD mandates photo evidence (FR-LOG-15,
 * FR-WST-01, petty cash, FR-HR-01 selfie, FR-PMS-04, every SJ drop).
 *
 * Tries `getUserMedia` first (live camera preview, capture-on-tap — the
 * better experience on a kitchen tablet); if the browser/device refuses
 * (permission denied, no camera, insecure context) it falls back to a plain
 * `<input type="file" accept="image/*" capture="environment">`, which still
 * opens the native camera app on a phone even without `getUserMedia`.
 *
 * `value` is a preview URL (an already-uploaded attachment's URL, or an
 * object URL for a not-yet-uploaded capture) — this component never uploads;
 * the caller wires `onCapture(file)` to `POST /api/attachments/presign` +
 * upload + confirm (CONTRACTS §4.0 kernel endpoints).
 */
export interface PhotoCaptureProps {
  label?: string;
  value: string | null;
  onCapture: (file: File) => void;
  onRemove?: () => void;
  /** "wajib foto" — shows the required marker and an error state until a photo exists. */
  required?: boolean;
  disabled?: boolean;
  error?: string;
  className?: string;
}

export function PhotoCapture({ label, value, onCapture, onRemove, required, disabled, error, className }: PhotoCaptureProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'idle' | 'camera'>('idle');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
  };

  useEffect(() => stopStream, []);

  async function openCamera() {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      streamRef.current = stream;
      setMode('camera');
      if (videoRef.current) videoRef.current.srcObject = stream;
    } catch {
      setCameraError(t('photo.cameraUnavailable'));
      fileInputRef.current?.click();
    }
  }

  function capture() {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) onCapture(new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' }));
      stopStream();
      setMode('idle');
    }, 'image/jpeg', 0.9);
  }

  function cancelCamera() {
    stopStream();
    setMode('idle');
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {label && (
        <span className="text-sm font-medium text-text-primary">
          {label}
          {required && <span className="ml-0.5 text-danger-600">*</span>}
        </span>
      )}

      {mode === 'camera' && (
        <div className="flex flex-col gap-2">
          <video ref={videoRef} autoPlay playsInline muted className="aspect-video w-full rounded-lg bg-stone-900 object-cover" />
          <div className="flex gap-2">
            <Button type="button" onClick={capture} leftIcon={<Camera className="size-4" />}>
              {t('photo.capture')}
            </Button>
            <Button type="button" variant="outline" onClick={cancelCamera}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {mode === 'idle' && value && (
        <div className="relative w-fit">
          {/* Plain <img>, deliberately not next/image: `value` is a blob:/data: object URL
              (a not-yet-uploaded capture, or a presigned attachment URL) that next/image's
              loader/optimizer isn't set up for. */}
          <img src={value} alt="" className="h-40 w-40 rounded-lg border border-border object-cover" />
          <div className="mt-2 flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={openCamera} leftIcon={<RotateCcw className="size-4" />} disabled={disabled}>
              {t('photo.retake')}
            </Button>
            {onRemove && (
              <Button type="button" size="sm" variant="ghost" onClick={onRemove} leftIcon={<X className="size-4" />} disabled={disabled}>
                {t('common.delete')}
              </Button>
            )}
          </div>
        </div>
      )}

      {mode === 'idle' && !value && (
        <div
          className={cn(
            'flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-6 text-center',
            error || required ? 'border-danger-600/40 bg-danger-50/30' : 'border-border-strong bg-surface-sunken',
          )}
        >
          <ImageOff className="size-8 text-text-muted" aria-hidden />
          <p className="text-sm text-text-muted">{required ? t('photo.wajibFoto') : t('photo.noPhoto')}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button type="button" size="sm" onClick={openCamera} leftIcon={<Camera className="size-4" />} disabled={disabled}>
              {t('photo.useCamera')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              leftIcon={<Upload className="size-4" />}
              disabled={disabled}
            >
              {t('photo.chooseFile')}
            </Button>
          </div>
          {cameraError && <p className="text-xs text-warning-600">{cameraError}</p>}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onCapture(file);
          e.target.value = '';
        }}
      />
      {error && <p className="text-sm text-danger-600">{error}</p>}
    </div>
  );
}
