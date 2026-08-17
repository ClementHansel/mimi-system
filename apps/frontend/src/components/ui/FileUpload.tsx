'use client';

import { useRef, useState, type DragEvent } from 'react';
import { UploadCloud, File as FileIcon, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Generic drag-and-drop / click-to-browse file upload (CSV import, PDF
 * attachments, non-photo evidence). For camera-first photo evidence use
 * `PhotoCapture` instead — that one is the "wajib foto" component.
 */
export interface FileUploadProps {
  label?: string;
  hint?: string;
  error?: string;
  accept?: string;
  multiple?: boolean;
  maxSizeMb?: number;
  value: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  className?: string;
}

export function FileUpload({
  label, hint, error, accept, multiple = false, maxSizeMb = 8, value, onChange, disabled, className,
}: FileUploadProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);

  function addFiles(files: FileList | null) {
    if (!files) return;
    const incoming = Array.from(files);
    const tooLarge = incoming.find((f) => f.size > maxSizeMb * 1024 * 1024);
    if (tooLarge) {
      setRejection(t('validation.fileTooLarge', { maxMb: maxSizeMb }));
      return;
    }
    setRejection(null);
    onChange(multiple ? [...value, ...incoming] : incoming.slice(0, 1));
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    addFiles(e.dataTransfer.files);
  }

  function removeAt(idx: number) {
    onChange(value.filter((_, i) => i !== idx));
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {label && <span className="text-sm font-medium text-text-primary">{label}</span>}
      <div
        role="button"
        tabIndex={0}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => e.key === 'Enter' && !disabled && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          'flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors',
          disabled && 'cursor-not-allowed opacity-60',
          dragOver ? 'border-brand-500 bg-brand-50' : error ? 'border-danger-600/40' : 'border-border-strong bg-surface-sunken',
        )}
      >
        <UploadCloud className="size-8 text-text-muted" aria-hidden />
        <p className="text-sm text-text-muted">{t('fileUpload.dragDrop')}</p>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          className="sr-only"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {value.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {value.map((file, idx) => (
            <li key={`${file.name}-${idx}`} className="flex items-center gap-2 rounded-md border border-border bg-surface-raised px-3 py-2 text-sm">
              <FileIcon className="size-4 flex-none text-text-muted" aria-hidden />
              <span className="flex-1 truncate">{file.name}</span>
              <button
                type="button"
                onClick={() => removeAt(idx)}
                aria-label={t('fileUpload.remove')}
                className="flex-none text-text-muted hover:text-danger-600"
              >
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {error || rejection ? (
        <p className="text-sm text-danger-600">{error ?? rejection}</p>
      ) : hint ? (
        <p className="text-sm text-text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
