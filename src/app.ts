import { fetchAirportByIcao } from './services/airportApi';
import { fetchMetarByIcao } from './services/metarApi';
import { mountAppController } from './ui/controller';

export function mountApp(root: HTMLElement): void {
  mountAppController(root, {
    fetchAirportByIcao,
    fetchMetarByIcao
  });
}
