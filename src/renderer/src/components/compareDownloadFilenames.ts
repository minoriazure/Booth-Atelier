const filenameOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

type DownloadFile = { filename: string; downloadableId: number }

export function compareDownloadFilenames(a: DownloadFile, b: DownloadFile): number {
  return filenameOrder.compare(a.filename, b.filename) || a.downloadableId - b.downloadableId
}
