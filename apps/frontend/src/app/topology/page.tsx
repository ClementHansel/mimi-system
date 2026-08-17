import { Waypoints } from 'lucide-react';
import { RoutePlaceholder } from '@/components/layout/RoutePlaceholder';

export default function TopologyPage() {
  return <RoutePlaceholder routeKey="topology" icon={<Waypoints className="size-8" />} />;
}
