// Require sustained pressure/recovery so isolated loads do not change quality.
export class FogQuality {
  level = 0
  private slowMs = 0
  private fastMs = 0

  get scale() {
    return [1, 0.8, 0.65][this.level]
  }

  sample(delta: number, visible: boolean) {
    if (!visible || delta <= 0 || delta > 250) {
      this.slowMs = this.fastMs = 0
      return false
    }
    this.slowMs = delta > 26 ? this.slowMs + delta : Math.max(0, this.slowMs - delta)
    this.fastMs = delta < 20 ? this.fastMs + delta : 0
    const previous = this.level
    if (this.slowMs >= 2000 && this.level < 2) this.level++
    else if (this.fastMs >= 8000 && this.level > 0) this.level--
    if (previous === this.level) return false
    this.slowMs = this.fastMs = 0
    return true
  }
}
