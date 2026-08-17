'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * `/` has no content of its own — it always hands off to `/dashboard`.
 * `AppShell`'s route guard takes it from there: an unauthenticated visitor
 * bounces straight on to `/login`.
 */
export default function RootPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/dashboard');
  }, [router]);
  return null;
}
