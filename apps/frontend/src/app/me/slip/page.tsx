import { MeSurface } from '@/components/me/MeSurface';
import { SlipGajiPanel } from '@/components/me/SlipGajiPanel';

export default function MeSlipPage() {
  return (
    <MeSurface titleKey="me.tabs.slip">
      <SlipGajiPanel />
    </MeSurface>
  );
}
