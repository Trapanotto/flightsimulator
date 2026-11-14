/**
 * Figures of an aircraft's systems. The systems code is generic; a type only brings its
 * numbers (the C172S ones, with their sources, are in c172.ts).
 */
export interface SystemsData {
  electrical: {
    /** Battery capacity, ampere hours, and internal resistance, ohm. */
    batteryAmpHours: number;
    batteryResistance: number;
    /** Open-circuit voltage of a full battery and of one at 20 % charge (below, it collapses). */
    batteryFullVolts: number;
    batteryLowVolts: number;
    /** Regulated bus voltage and maximum output of the alternator. */
    alternatorVolts: number;
    alternatorAmps: number;
    /** Engine rpm where the alternator starts to give current and where it gives all of it. */
    alternatorCutInRpm: number;
    alternatorFullRpm: number;
    /** Below this the low-voltage annunciator lights. */
    lowVolts: number;
    /** Below these the avionics drop off, and then everything else on the main bus. */
    avionicsMinVolts: number;
    busMinVolts: number;
    /** Current of each consumer at bus voltage, A. */
    loads: {
      /** Engine instruments, annunciators, turn coordinator, fuel gauges: always on with the master. */
      base: number;
      panelLights: number;
      beacon: number;
      strobe: number;
      nav: number;
      landing: number;
      taxi: number;
      pitotHeat: number;
      avionics: number;
      flapsMotor: number;
      starter: number;
      fuelPump: number;
    };
  };
  fuel: {
    /** Usable fuel of one wing tank, kg. */
    tankUsable: number;
    /** Lateral distance of a tank's fuel from the centre line, m. */
    tankArm: number;
    /** The low-fuel annunciator of a tank lights below this, kg. */
    lowFuel: number;
    /** What the fuel leak failure loses, kg/s. */
    leakRate: number;
    /** Fuel in the lines and the injection system after the supply stops, kg. */
    lineFuel: number;
  };
  engine: {
    /** Power lost on one magneto (one spark plug per cylinder burns slower). */
    singleMagnetoLoss: number;
    /** Power lost with the alternate air door open (warmer, unfiltered air). */
    alternateAirLoss: number;
    /** Oil pressure, psi: warm at rated rpm, and the relief valve's limit. */
    oilPressure: number;
    oilPressureMax: number;
    /** Annunciator thresholds: oil pressure (psi). */
    lowOilPressure: number;
  };
  vacuum: {
    /** Regulated suction, in Hg, the engine rpm it is reached at, and the annunciator limit. */
    suction: number;
    fullRpm: number;
    low: number;
  };
  icing: {
    /** Extra mass of heavy airframe ice, kg. */
    iceMass: number;
  };
}
