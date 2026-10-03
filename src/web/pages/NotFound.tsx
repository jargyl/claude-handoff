import { Link } from 'react-router';
import { Compass } from 'lucide-react';
import { EmptyState, Button } from '../components/ui';

export default function NotFound() {
  return (
    <EmptyState
      icon={Compass}
      title="This page doesn't exist"
      action={
        <Link to="/">
          <Button variant="primary">Go to overview</Button>
        </Link>
      }
    >
      The link may be out of date, or the session was deleted.
    </EmptyState>
  );
}
