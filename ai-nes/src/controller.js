export class Controller {
  constructor() {
    // Button state stored as bits in a single byte
    // Bit 0 = A, 1 = B, 2 = Select, 3 = Start, 4 = Up, 5 = Down, 6 = Left, 7 = Right
    this.currentState = 0;   // Current button state (updated by buttonDown/buttonUp)
    this.strobedState = 0;   // Latched state (snapshot when strobe goes low)
    this.strobeByte = 0;     // Strobe signal (1 = strobing, 0 = reading)
    this.shiftRegister = 0;  // Current position in shift register (0-7)
  }

  // Called when CPU reads from $4016/$4017
  read() {
    let ret = 0;
    if (this.strobeByte === 1) {
      // Strobe mode: always return button A state
      ret = this.currentState & 1;
    } else {
      if (this.shiftRegister < 8) {
        // Normal read mode: return one bit at a time from latched state
        ret = (this.strobedState >> this.shiftRegister) & 1;
      } else {
        // After 8 reads, controllers return 1.
        ret = 1;
      }
    }
    // Hardware accuracy: Bits 5-7 are Open Bus (usually $40 for $4016/$4017 reads).
    // Returning 0x40 ensures games checking these bits (like Paperboy or Captain Planet) work.
    return 0x40 | ret;
  }

  // Called after each CPU read to advance the shift register
  // This separation allows double-reads to get the same value
  clock() {
    if (this.strobeByte === 0 && this.shiftRegister < 8) {
      this.shiftRegister++;
    }
  }

  // Called when CPU writes to $4016 (strobe signal)
  strobe(data) {
    // Latch on the falling edge of the strobe signal (1 -> 0)
    if (this.strobeByte === 1 && (data & 1) === 0) {
      this.strobedState = this.currentState;
      this.shiftRegister = 0;
    }
    this.strobeByte = data & 1;
  }

  // Prevent simultaneous opposite directions (hardware behavior)
  _getDuplicateMask(buttonIndex) {
    switch (buttonIndex) {
      case 4: return 0xDF; // UP pressed: clear DOWN (bit 5)
      case 5: return 0xEF; // DOWN pressed: clear UP (bit 4)
      case 6: return 0x7F; // LEFT pressed: clear RIGHT (bit 7)
      case 7: return 0xBF; // RIGHT pressed: clear LEFT (bit 6)
      default: return 0xFF;
    }
  }

  buttonDown(button) {
    // Set the bit for this button
    this.currentState |= (1 << button);
    // Prevent opposite directional inputs (can't press up+down or left+right)
    this.currentState &= this._getDuplicateMask(button);
  }

  buttonUp(button) {
    // Clear the bit for this button
    this.currentState &= (0xFF ^ (1 << button));
  }
}

// Button index constants
Controller.BUTTON_A = 0;
Controller.BUTTON_B = 1;
Controller.BUTTON_SELECT = 2;
Controller.BUTTON_START = 3;
Controller.BUTTON_UP = 4;
Controller.BUTTON_DOWN = 5;
Controller.BUTTON_LEFT = 6;
Controller.BUTTON_RIGHT = 7;