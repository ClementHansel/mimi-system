import { MeSurface } from '@/components/me/MeSurface';
import { PinjamanPanel } from '@/components/me/PinjamanPanel';

export default function MePinjamanPage() {
  return (
    <MeSurface titleKey="me.tabs.pinjaman">
      <PinjamanPanel />
    </MeSurface>
  );
}
