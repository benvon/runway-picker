import { fetchAirportByIcao } from './services/airportApi';
import { fetchMetarByIcao } from './services/metarApi';
import { readBuildMetadata } from './buildMetadata';
import { mountAppController, type AppControllerOptions } from './ui/controller';

export function mountApp(root: HTMLElement, options: AppControllerOptions = {}): () => void {
  const buildMetadata = readBuildMetadata();

  return mountAppController(root, {
    fetchAirportByIcao,
    fetchMetarByIcao
  }, buildMetadata, options);
}
