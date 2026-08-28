import { MeSurface } from '@/components/me/MeSurface';
import { AbsenPanel } from '@/components/me/AbsenPanel';

export default function MeAbsenPage() {
  return (
    <MeSurface titleKey="me.tabs.absen">
      <AbsenPanel />
    </MeSurface>
  );
}
