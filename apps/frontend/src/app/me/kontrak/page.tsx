import { MeSurface } from '@/components/me/MeSurface';
import { KontrakPanel } from '@/components/me/KontrakPanel';

export default function MeKontrakPage() {
  return (
    <MeSurface titleKey="me.tabs.kontrak">
      <KontrakPanel />
    </MeSurface>
  );
}
