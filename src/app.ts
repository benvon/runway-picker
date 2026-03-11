import { fetchAirportByIcao } from './services/airportApi';
import { fetchMetarByIcao } from './services/metarApi';
import { readBuildMetadata } from './buildMetadata';
import { mountAppController } from './ui/controller';

export function mountApp(root: HTMLElement): void {
  const buildMetadata = readBuildMetadata();

  mountAppController(root, {
    fetchAirportByIcao,
    fetchMetarByIcao
  }, buildMetadata.footerLabel);
}
