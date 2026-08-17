import { ClipboardList } from 'lucide-react';
import { RoutePlaceholder } from '@/components/layout/RoutePlaceholder';

export default function PurchasingPage() {
  return <RoutePlaceholder routeKey="purchasing" icon={<ClipboardList className="size-8" />} />;
}
