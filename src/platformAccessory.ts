import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { OlarmHomebridgePlatform } from './platform';
import { Olarm, OlarmArea, OlarmAreaState } from './olarm';
import { OlarmAreaAction } from './olarm';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class OlarmAreaPlatformAccessory {
  private service: Service;
  private currentState: OlarmAreaState = OlarmAreaState.Disarmed;
  private targetState: OlarmAreaState = OlarmAreaState.Disarmed;
  // private motionSensorOneService: Service;
  private currentOlarmAreaState!: OlarmArea;

  constructor(
    private readonly platform: OlarmHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Olarm');

    // get the SecuritySystem service if it exists, otherwise create a new SecuritySystem service
    // you can create multiple services for each accessory

    this.service = this.accessory.getService(this.platform.Service.SecuritySystem) || this.accessory.addService(this.platform.Service.SecuritySystem);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.context.area.areaName);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/SecuritySystem

    // register handlers for the SecuritySystemCurrentState Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.SecuritySystemCurrentState)
      .onGet(this.handleSecuritySystemCurrentStateGet.bind(this));

    // register handlers for the SecuritySystemTargetState Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.SecuritySystemTargetState)
      .onGet(this.handleSecuritySystemTargetStateGet.bind(this))
      .onSet(this.handleSecuritySystemTargetStateSet.bind(this));


    // Initialize the states
    this.currentState = this.accessory.context.area.areaState;
    this.targetState = this.currentState;

    // Initialize occupancy sensors
    // Loop through all configured PIR zones and create an occupancy sensor for each one 
    this.platform.config.occupancyZones.forEach((zone: number) => {
      this.platform.log.debug(`Add occupancy sensor for zone: ${zone.toString()}`);
      const sensorName: string = `Zone ${zone.toString()} Sensor`;
      let occupancySensorService : Service;
      occupancySensorService = this.accessory.getService(sensorName) ||
        this.accessory.addService(this.platform.Service.OccupancySensor, sensorName, `${this.accessory.context.area.areaName}-Zone${zone.toString()}Sensor`);
      
      occupancySensorService.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
      occupancySensorService.setCharacteristic(this.platform.Characteristic.ConfiguredName, sensorName);

      this.platform.log.debug(`Occupancy sensor: "${sensorName}" / "${this.accessory.context.area.areaName}-Zone${zone.toString()}Sensor" added`);
    });

    // setInterval(async () => {
    setInterval(() => {
      this.getOccupancyZones();
    }, this.platform.config.pollingInterval);
  }

  convertFromOlarmAreaState = (s: OlarmAreaState): CharacteristicValue => {

    /**
     * APPLE  OLARM
     * Home   <unused> -> Stay
     * Away   Armed
     * Night  Stay
     * Off    Disarmed
     * ...
     */
    switch (s) {
      case OlarmAreaState.Armed:
        return this.platform.Characteristic.SecuritySystemCurrentState.AWAY_ARM; // Away => Armed
      case OlarmAreaState.ArmedStay:
        return this.platform.Characteristic.SecuritySystemCurrentState.NIGHT_ARM; // Night => Stay
      case OlarmAreaState.Disarmed:
        return this.platform.Characteristic.SecuritySystemCurrentState.DISARMED;
      case OlarmAreaState.NotReady:
        return this.platform.Characteristic.SecuritySystemCurrentState.DISARMED;
      case OlarmAreaState.Triggered: // todo
      default:
        return this.platform.Characteristic.SecuritySystemCurrentState.DISARMED;
    }
    // static readonly STAY_ARM = 0; // "Home"
    // static readonly AWAY_ARM = 1; // "Away"
    // static readonly NIGHT_ARM = 2; // "Night"
    // static readonly DISARMED = 3; // "Off"
    // static readonly ALARM_TRIGGERED = 4; // ?
  };

  convertToOlarmAreaState = (s: CharacteristicValue): OlarmAreaState => {
    switch (s) {
      case this.platform.Characteristic.SecuritySystemCurrentState.STAY_ARM:
        return OlarmAreaState.ArmedStay;
      case this.platform.Characteristic.SecuritySystemCurrentState.AWAY_ARM:
        return OlarmAreaState.Armed;
      case this.platform.Characteristic.SecuritySystemCurrentState.NIGHT_ARM:
        return OlarmAreaState.ArmedStay;
      case this.platform.Characteristic.SecuritySystemCurrentState.DISARMED:
        return OlarmAreaState.Disarmed;
      case this.platform.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED:
        return OlarmAreaState.Triggered; // todo
      default:
        return OlarmAreaState.Disarmed;
    }
  };

  // Validate if PIR Zone has triggered based on configured occupancy delay time
  convertFromOlarmZoneOccupancy = (zone: number, olarmArea: OlarmArea): CharacteristicValue => {

    // Check zone timestamp vs device timestamp against polling interval
    this.platform.log.debug('Zone Occupancy check for zone: ' + zone + ' ZoneStamp: ' + olarmArea.zonesStamp[zone - 1] + ' DeviceStamp: ' + olarmArea.deviceTimestamp)
    const differenceInMs = olarmArea.deviceTimestamp - olarmArea.zonesStamp[zone - 1];
    if (differenceInMs < this.platform.config.occupancyDelay) {
      this.platform.log.info(`GET ZoneState for Zone ` + zone + ' Set to OCCUPANCY_DETECTED');
      return this.platform.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED;
    }
    else {
      this.platform.log.info(`GET ZoneState for Zone ` + zone + ' Set to OCCUPANCY_NOT_DETECTED');
      return this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
    }
  };

  /**
     * Handle requests to get the current value of the "Security System Current State" characteristic
     */
  async handleSecuritySystemCurrentStateGet() {
    let olarmArea: OlarmArea;

    // Ensure min 15 seconds between API query    
    if (this.currentOlarmAreaState !== undefined && this.currentOlarmAreaState !== null && this.currentOlarmAreaState.deviceTimestamp + 15000 > Date.now()) {
      this.platform.log.info(`GET Cache State Epoch ${this.currentOlarmAreaState.deviceTimestamp.toString()} System Epoch ${Date.now().toString()}`);
      olarmArea = this.currentOlarmAreaState;
    }
    else {
      const olarmAreas = await this.platform.olarm.getAreas();
      const area = this.accessory.context.area as OlarmArea;
      olarmArea = olarmAreas.find(oa => oa.areaName === area.areaName)!;

      // Store current state of olarm info
      this.currentOlarmAreaState = olarmArea!;
    }   

    this.platform.log.info(`GET CurrentState (${olarmArea?.areaName}) from ${this.currentState} to ${olarmArea!.areaState} (target: ${this.targetState})`);
    this.currentState = olarmArea!.areaState;

    if (this.currentState !== OlarmAreaState.NotReady)
      this.targetState = this.currentState;

    // Update HomeKit state
    this.service.updateCharacteristic(this.platform.Characteristic.SecuritySystemCurrentState, this.convertFromOlarmAreaState(this.currentState));
    this.service.updateCharacteristic(this.platform.Characteristic.SecuritySystemTargetState, this.convertFromOlarmAreaState(this.targetState));

    return this.convertFromOlarmAreaState(olarmArea!.areaState);
  }

  /**
   * Handle requests to get the current value of the "Security System Target State" characteristic
   */
  async handleSecuritySystemTargetStateGet() {
    this.platform.log.info(`GET TargetState (${this.accessory.context.area.areaName}) ${this.targetState} (current: ${this.currentState})`);
    return this.convertFromOlarmAreaState(this.targetState);
  }

  /**
   * Handle requests to set the "Security System Target State" characteristic
   */
  async handleSecuritySystemTargetStateSet(value: CharacteristicValue) {
    const olarmAreaStateValue = this.convertToOlarmAreaState(value);

    // Determine olarm action
    const area = this.accessory.context.area;
    let olarmAreaAction = OlarmAreaAction.Disarm;
    if (olarmAreaStateValue === OlarmAreaState.Armed)
      olarmAreaAction = OlarmAreaAction.Arm;
    if (olarmAreaStateValue === OlarmAreaState.ArmedStay)
      olarmAreaAction = OlarmAreaAction.Stay;

    this.platform.log.info(`SET TargetState (${this.accessory.context.area.areaName}) from ${this.targetState} to ${olarmAreaStateValue} with "${olarmAreaAction}"`);
    this.targetState = olarmAreaStateValue;

    // Ping olarm to update
    await this.platform.olarm.setArea(area, olarmAreaAction);

    // Update actual state
    this.currentState = this.targetState;
    this.platform.log.info(' - (SET) Updated', this.accessory.context.area.areaName, 'to', olarmAreaStateValue);

    // Update HomeKit state
    this.service.updateCharacteristic(this.platform.Characteristic.SecuritySystemCurrentState, this.convertFromOlarmAreaState(this.currentState));
    this.service.updateCharacteristic(this.platform.Characteristic.SecuritySystemTargetState, this.convertFromOlarmAreaState(this.targetState));
  }

  // private async getOccupancyZones(): Promise<void> {
    private async getOccupancyZones() {
      this.platform.log.debug(`Get Occupancy zones for configured zones`);
      
      // Schedule security event, refreshing alarm data
      await this.handleSecuritySystemCurrentStateGet();

      //const olarmAreas = await this.platform.olarm.getAreas();
      // const area = this.accessory.context.area as OlarmArea;
      // const olarmArea = olarmAreas.find(oa => oa.areaName === area.areaName)!;

      this.platform.config.occupancyZones.forEach((zone: number) => {
        this.platform.log.debug(`Get occupancy sensor for zone: ${zone.toString()}`);
        // let occupancySensorService = this.accessory.addService(this.platform.Service.OccupancySensor);
        
        // let occupancyService = this.accessory.getService(`Zone ${zone.toString()} Sensor`);
        this.accessory.getService(`Zone ${zone.toString()} Sensor`)!.updateCharacteristic(this.platform.Characteristic.OccupancyDetected, this.convertFromOlarmZoneOccupancy(zone, this.currentOlarmAreaState));
        // this.platform.log.debug(`Occupancy sensor: ${occupancyService!.name} Zone#: ${zone.toString()}`);

        // let motionDetected = this.convertFromOlarmZoneOccupancy(zone, this.currentOlarmAreaState);
        // occupancyService!.updateCharacteristic(this.platform.Characteristic.OccupancyDetected, motionDetected);
  
        // occupancySensorService.setCharacteristic(this.platform.Characteristic.Name, "Zone" + zone);
        // occupancySensorService.updateCharacteristic(this.platform.Characteristic.Name, "Zone" + zone);
        // push the new value to HomeKit
        // occupancySensorService.updateCharacteristic(this.platform.Characteristic.OccupancyDetected, );
        
        // this.platform.log.debug(`Occupancy sensor: "Zone ${zone.toString()} Sensor" / "${this.accessory.context.area.areaName}-Zone${zone.toString()}Sensor" added`);
      });

      // Check occupancy for all configured zones
      // this.occupancySensors.forEach((occupancyService: Service) => {
      //   this.platform.log.debug(`Check occupancy for ${occupancyService.name} Zone# ${occupancyService.name?.slice(4 - occupancyService.name.length)}`);
      //   // Check zone occupancy changes
      //   let currentZone = Number(occupancyService.name?.slice(4 - occupancyService.name.length));
      //   let motionDetected = this.convertFromOlarmZoneOccupancy(currentZone, this.currentOlarmAreaState);
      //   occupancyService.updateCharacteristic(this.platform.Characteristic.OccupancyDetected, motionDetected);

      // // push the new value to HomeKit
      // // this.motionSensorOneService.updateCharacteristic(this.platform.Characteristic.OccupancyDetected, motionDetected);    
      // })

      // Check zone7 for now
      // let motionDetected = this.convertFromOlarmZoneOccupancy(7, this.currentOlarmAreaState);

      // push the new value to HomeKit
      // this.motionSensorOneService.updateCharacteristic(this.platform.Characteristic.OccupancyDetected, motionDetected);
  }

}
