'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from './Button';

/**
 * Pointer-events signature capture — used for Surat Jalan drop receiving
 * (D-14, "tanda tangan" at every drop). Draws on a `<canvas>`; commits a PNG
 * data URL to `onChange` at the end of each stroke (not on every move) so the
 * caller isn't flooded with intermediate frames.
 */
export interface SignaturePadProps {
  label?: string;
  value: string | null;
  onChange: (dataUrl: string | null) => void;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  width?: number;
  height?: number;
  className?: string;
}

export function SignaturePad({
  label,
  value,
  onChange,
  required,
  disabled,
  error,
  width = 400,
  height = 160,
  className,
}: SignaturePadProps) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasStroke = useRef(false);
  const [empty, setEmpty] = useState(!value);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (value) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      img.src = value;
      setEmpty(false);
    } else {
      setEmpty(true);
    }
    // Deliberately runs once on mount only: re-initializes the canvas from
    // `value` when the pad first appears, but must NOT re-run on every
    // `value` change afterwards — that would wipe an in-progress stroke each
    // time this component's own `onChange` reports the canvas back up.
  }, []);

  function getPos(e: ReactPointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    drawing.current = true;
    hasStroke.current = true;
    const { x, y } = getPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1a1714';
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = getPos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function onPointerUp() {
    if (!drawing.current) return;
    drawing.current = false;
    if (hasStroke.current) {
      setEmpty(false);
      onChange(canvasRef.current?.toDataURL('image/png') ?? null);
    }
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    hasStroke.current = false;
    setEmpty(true);
    onChange(null);
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {label && (
        <span className="text-sm font-medium text-text-primary">
          {t('signature.label')} {label && `— ${label}`}
          {required && <span className="ml-0.5 text-danger-600">*</span>}
        </span>
      )}
      <div
        className={cn(
          'relative w-fit rounded-lg border-2 border-dashed',
          error ? 'border-danger-600/40' : 'border-border-strong',
        )}
      >
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          className={cn('touch-none rounded-lg bg-white', disabled && 'opacity-60')}
        />
        {empty && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-text-muted">
            {t('signature.placeholder')}
          </span>
        )}
      </div>
      <div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={clear}
          disabled={disabled || empty}
        >
          {t('signature.clear')}
        </Button>
      </div>
      {error && <p className="text-sm text-danger-600">{error}</p>}
    </div>
  );
}
