export class TFile {
  path: string;
  name: string;
  basename: string;
  extension: string;

  constructor(path = '') {
    this.path = path;
    this.name = path.split('/').pop() ?? path;
    const dot = this.name.lastIndexOf('.');
    this.extension = dot === -1 ? '' : this.name.slice(dot + 1);
    this.basename = dot === -1 ? this.name : this.name.slice(0, dot);
  }
}
