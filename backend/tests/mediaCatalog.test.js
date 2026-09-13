import { getActivityMedia, getDestinationMedia } from '../src/services/mediaCatalog.js';

describe('mediaCatalog', () => {
  test('risolve la destinazione senza dipendere da maiuscole o spazi', () => {
    const media = getDestinationMedia(' SPAGNA ', 'barcellona');
    expect(media).toMatchObject({ author: 'Julian Lupyan', license: 'CC0 1.0' });
    expect(media.url).toContain('commons.wikimedia.org');
    expect(media.url).toContain('width=960');
  });

  test('restituisce null per una destinazione priva di immagine', () => {
    expect(getDestinationMedia('Portogallo', 'Lisbona')).toBeNull();
  });

  test('associa solo immagini pertinenti alle attività note', () => {
    expect(getActivityMedia('Museo Picasso')).toMatchObject({ license: 'CC BY-SA 3.0' });
    expect(getActivityMedia('Attività non catalogata')).toBeNull();
  });
});
