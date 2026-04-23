import { describe, expect, it } from 'vitest';
import { summarizeAirportFrequencies } from './airportInfo';
import type { AirportFrequency, RunwayEnd } from '../../domain/types';

function runway(id: string, headingDegMag: number): RunwayEnd {
  return { id, headingDegMag, isClosed: false, lengthFt: 8000 };
}

function frequency(type: string, description: string, frequencyMhz: string): AirportFrequency {
  return { type, description, frequencyMhz };
}

describe('airportInfo', () => {
  it('chooses the north approach frequency for southbound runway approaches', () => {
    const summary = summarizeAirportFrequencies(
      [runway('18', 180)],
      [
        frequency('APP', 'NORTH APPROACH', '120.1'),
        frequency('APP', 'SOUTH APPROACH', '124.2'),
        frequency('TWR', 'TOWER', '118.5'),
        frequency('ATIS', 'ATIS', '126.8'),
        frequency('CTAF', 'CTAF', '122.8')
      ],
      '18'
    );

    expect(summary).toEqual({
      approach: '120.1 MHz',
      departure: 'N/A',
      tower: '118.5 MHz',
      ground: 'N/A',
      weatherLabel: 'ATIS',
      weather: '126.8 MHz',
      ctaf: '122.8 MHz'
    });
  });

  it('chooses the west approach frequency for eastbound runway approaches', () => {
    const summary = summarizeAirportFrequencies(
      [runway('09', 90)],
      [
        frequency('APP', 'WEST APP', '119.4'),
        frequency('APP', 'EAST APP', '121.2')
      ],
      '09'
    );

    expect(summary.approach).toBe('119.4 MHz');
  });

  it('falls back to all approach frequencies when approach sectors are not direction-split', () => {
    const summary = summarizeAirportFrequencies(
      [runway('27', 270)],
      [
        frequency('APP', 'CITY APPROACH', '119.4'),
        frequency('ARR', 'FINAL APPROACH', '125.3')
      ],
      '27'
    );

    expect(summary.approach).toBe('119.4 MHz, 125.3 MHz');
  });

  it('treats a/d as both approach and departure and lowercase app as approach', () => {
    const summary = summarizeAirportFrequencies(
      [runway('18', 180)],
      [
        frequency('a/d', 'NORTH APPROACH', '120.1'),
        frequency('app', 'SOUTH APPROACH', '124.2'),
        frequency('dep', 'CITY DEPARTURE', '121.7')
      ],
      '18'
    );

    expect(summary.approach).toBe('120.1 MHz');
    expect(summary.departure).toBe('120.1 MHz, 121.7 MHz');
  });

  it('treats unic as a ctaf alias, lowercase twr as tower, and lowercase gnd as ground', () => {
    const summary = summarizeAirportFrequencies(
      [runway('36', 360)],
      [
        frequency('unic', 'UNICOM', '122.8'),
        frequency('twr', 'TOWER', '118.5'),
        frequency('gnd', 'GROUND', '121.9'),
        frequency('cld', 'CLEARANCE', '124.4')
      ],
      '36'
    );

    expect(summary).toEqual({
      approach: 'N/A',
      departure: 'N/A',
      tower: '118.5 MHz',
      ground: '121.9 MHz',
      weatherLabel: 'AWOS / ATIS / ASOS',
      weather: 'N/A',
      ctaf: '122.8 MHz'
    });
  });

  it('falls back to all approach frequencies when the best runway is not determinable', () => {
    const summary = summarizeAirportFrequencies(
      [runway('04', 40)],
      [
        frequency('APP', 'NORTH APPROACH', '119.4'),
        frequency('APP', 'SOUTH APPROACH', '121.2')
      ],
      null
    );

    expect(summary.approach).toBe('119.4 MHz, 121.2 MHz');
  });

  it('labels weather frequencies with the specific detected service types', () => {
    const summary = summarizeAirportFrequencies(
      [runway('36', 360)],
      [frequency('AWOS', 'AWOS', '118.0'), frequency('ASOS', 'ASOS', '135.4')],
      '36'
    );

    expect(summary).toEqual({
      approach: 'N/A',
      departure: 'N/A',
      tower: 'N/A',
      ground: 'N/A',
      weatherLabel: 'AWOS / ASOS',
      weather: '118.0 MHz, 135.4 MHz',
      ctaf: 'N/A'
    });
  });
});
