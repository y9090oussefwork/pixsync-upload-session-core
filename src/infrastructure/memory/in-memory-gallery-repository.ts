import type { Gallery } from "../../domain/types.js";
import type { GalleryRepository } from "../../application/ports.js";
import { clone, tick } from "./utils.js";

export class InMemoryGalleryRepository implements GalleryRepository {
  private readonly galleries = new Map<string, Gallery>();

  constructor(galleries: readonly Gallery[] = []) {
    for (const gallery of galleries) {
      this.galleries.set(gallery.id, clone(gallery));
    }
  }

  async findById(galleryId: string): Promise<Gallery | null> {
    await tick();
    const gallery = this.galleries.get(galleryId);
    return gallery ? clone(gallery) : null;
  }
}
