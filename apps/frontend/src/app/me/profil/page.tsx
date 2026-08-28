import { MeSurface } from '@/components/me/MeSurface';
import { ProfilePanel } from '@/components/me/ProfilePanel';

export default function MeProfilPage() {
  return (
    <MeSurface titleKey="me.tabs.profile">
      <ProfilePanel />
    </MeSurface>
  );
}
