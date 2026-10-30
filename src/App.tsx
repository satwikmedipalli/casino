import { Lobby } from './Lobby';
import { usePoker } from './net';
import { Table } from './Table';

export function App() {
  const poker = usePoker();
  return poker.state ? <Table poker={poker} /> : <Lobby poker={poker} />;
}
