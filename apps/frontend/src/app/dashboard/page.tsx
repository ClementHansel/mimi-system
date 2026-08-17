import { LayoutDashboard } from 'lucide-react';
import { RoutePlaceholder } from '@/components/layout/RoutePlaceholder';

export default function DashboardPage() {
  return <RoutePlaceholder routeKey="dashboard" icon={<LayoutDashboard className="size-8" />} />;
}
