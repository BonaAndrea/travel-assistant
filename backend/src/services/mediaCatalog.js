const COMMONS_BASE = 'https://commons.wikimedia.org/wiki/Special:Redirect/file';

function commonsImage(fileName, { alt, author, license, licenseUrl, sourceUrl }) {
  return Object.freeze({
    url: `${COMMONS_BASE}/${encodeURIComponent(fileName)}?width=960`,
    alt, author, license, licenseUrl, sourceUrl,
  });
}

const destinationMedia = new Map([
  ['spagna|barcellona', commonsImage('Sagrada Família, Barcelona.jpg', {
    alt: 'Panorama di Barcellona con la Sagrada Família',
    author: 'Julian Lupyan', license: 'CC0 1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Sagrada_Fam%C3%ADlia,_Barcelona.jpg',
  })],
]);

const activityMedia = new Map([
  ['tour guidato sagrada familia', commonsImage('La Sagrada Familia Barcelona.jpg', {
    alt: 'Esterno della Sagrada Família a Barcellona',
    author: 'Peter Broster', license: 'CC0 1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:La_Sagrada_Familia_Barcelona.jpg',
  })],
  ['museo picasso', commonsImage('Museu-Picasso Barcelona.jpg', {
    alt: 'Ingresso del Museu Picasso di Barcellona',
    author: 'Haitham Alfalah', license: 'CC BY-SA 3.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Museu-Picasso_Barcelona.jpg',
  })],
]);

function normalize(value) {
  return String(value || '').trim().toLocaleLowerCase('it');
}

export function getDestinationMedia(country, city) {
  return destinationMedia.get(`${normalize(country)}|${normalize(city)}`) || null;
}

// Il matching esatto evita di mostrare una foto solo vagamente correlata.
export function getActivityMedia(name) {
  return activityMedia.get(normalize(name)) || null;
}
