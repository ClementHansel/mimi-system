'use client';

import { useState } from 'react';
import { Store } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  RadioGroup,
} from '@/components/ui';
import type { PosOutletOption } from './pos-runtime';

/**
 * F02-FIX — shown when the session isn't scoped to exactly one outlet: a
 * head-office role (`Me.locations: []`, D-05) choosing among every outlet
 * `location.read` lets the server show them, or a supervisor account with
 * several assigned outlets choosing among those. The chosen outlet is
 * persisted by the caller (`usePosLocation`'s `select`) so this screen isn't
 * shown again on reload, and `PosStatusBar` exposes a way back here
 * (`onChangeLocation`) so the choice always stays visible and changeable.
 */
export function PosLocationPicker({
  options,
  onSelect,
}: {
  options: PosOutletOption[];
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState('');

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Store className="size-5 text-brand-600" aria-hidden />
            {t('pos.chooseOutletTitle')}
          </CardTitle>
          <CardDescription>{t('pos.chooseOutletDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (value) onSelect(value);
            }}
          >
            <RadioGroup
              options={options.map((o) => ({ value: o.id, label: o.name }))}
              value={value}
              onValueChange={setValue}
            />
            <Button type="submit" size="touch-lg" fullWidth disabled={!value}>
              {t('pos.chooseOutletSubmit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
