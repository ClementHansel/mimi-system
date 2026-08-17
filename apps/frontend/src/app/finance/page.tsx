import { Landmark } from 'lucide-react';
import { RoutePlaceholder } from '@/components/layout/RoutePlaceholder';

export default function FinancePage() {
  return <RoutePlaceholder routeKey="finance" icon={<Landmark className="size-8" />} />;
}
