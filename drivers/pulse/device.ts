import { Device, FlowCardTriggerDevice } from 'homey';
import _ from 'lodash';
import moment from 'moment-timezone';
import http from 'http.min';
import { Subscription } from 'apollo-client/util/Observable';
import { LiveMeasurement, TibberApi } from '../../lib/tibber';
import { NordpoolPriceResult } from '../../lib/types';

class PulseDevice extends Device {
  #tibber!: TibberApi;
  #deviceId!: string;
  #throttle!: number;
  #currency?: string;
  #cachedNordpoolPrice: { hour: number; price: number } | null = null;
  #area?: string;
  #prevPowerProduction?: number;
  #prevUpdate?: moment.Moment;
  #prevPower?: number;
  #prevCurrentL1?: number;
  #prevCurrentL2?: number;
  #prevCurrentL3?: number;
  #prevConsumption?: number;
  #prevCost?: number;
  #wsSubscription!: Subscription;
  #resubscribeDebounce!: _.DebouncedFunc<() => void>;
  #powerChangedTrigger!: FlowCardTriggerDevice;
  #consumptionChangedTrigger!: FlowCardTriggerDevice;
  #costChangedTrigger!: FlowCardTriggerDevice;
  #currentL1ChangedTrigger!: FlowCardTriggerDevice;
  #currentL2ChangedTrigger!: FlowCardTriggerDevice;
  #currentL3ChangedTrigger!: FlowCardTriggerDevice;
  #dailyConsumptionReportTrigger!: FlowCardTriggerDevice;

  async onInit() {
    const { id, t: token } = this.getData();

    this.#tibber = new TibberApi(this.log, this.homey.settings, id, token);
    this.#deviceId = id;
    this.#throttle = this.getSetting('pulse_throttle') || 30;

    this.#powerChangedTrigger =
      this.homey.flow.getDeviceTriggerCard('power_changed');

    this.#consumptionChangedTrigger = this.homey.flow.getDeviceTriggerCard(
      'consumption_changed',
    );

    this.#costChangedTrigger =
      this.homey.flow.getDeviceTriggerCard('cost_changed');

    this.#currentL1ChangedTrigger =
      this.homey.flow.getDeviceTriggerCard('current.L1_changed');

    this.#currentL2ChangedTrigger =
      this.homey.flow.getDeviceTriggerCard('current.L2_changed');

    this.#currentL3ChangedTrigger =
      this.homey.flow.getDeviceTriggerCard('current.L3_changed');

    this.#dailyConsumptionReportTrigger = this.homey.flow.getDeviceTriggerCard(
      'daily_consumption_report',
    );

    this.log(
      `Tibber pulse device ${this.getName()} has been initialized (throttle: ${
        this.#throttle
      })`,
    );

    // Resubscribe if no data for 10 minutes
    this.#resubscribeDebounce = _.debounce(
      this.#subscribeToLive.bind(this),
      10 * 60 * 1000,
    );
    this.#subscribeToLive();
  }

  async onSettings({
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: string };
    newSettings: { [key: string]: string };
    changedKeys: string[];
  }) {
    this.log('Changing pulse settings');

    if (changedKeys.includes('pulse_throttle')) {
      this.log('Updated throttle value: ', newSettings.pulse_throttle);
      this.#throttle = Number(newSettings.pulse_throttle) || 30;
    }
    if (changedKeys.includes('pulse_currency')) {
      this.log('Updated currency value: ', newSettings.pulse_currency);
      this.#currency = newSettings.pulse_currency;
      this.#cachedNordpoolPrice = null;
    }
    if (changedKeys.includes('pulse_area')) {
      this.log('Updated area value: ', newSettings.pulse_area);
      this.#area = newSettings.pulse_area;
      this.#cachedNordpoolPrice = null;
    }
  }

  #subscribeToLive() {
    this.#resubscribeDebounce();
    if (
      this.#wsSubscription &&
      _.isFunction(this.#wsSubscription.unsubscribe)
    ) {
      try {
        this.log('Unsubscribing from previous connection');
        this.#wsSubscription.unsubscribe();
      } catch (e) {
        this.log('Error unsubscribing from previous connection', e);
      }
    }

    this.log('Subscribing to live data for homeId', this.#deviceId);
    this.#wsSubscription = this.#tibber.subscribeToLive(
      this.subscribeCallback.bind(this),
    );
  }

  async subscribeCallback(result: LiveMeasurement) {
    this.#resubscribeDebounce();

    const power = result.data?.liveMeasurement?.power;
    const powerProduction = result.data?.liveMeasurement?.powerProduction;
    if (powerProduction) this.#prevPowerProduction = powerProduction;

    if (
      this.#prevUpdate &&
      moment().diff(this.#prevUpdate, 'seconds') < this.#throttle
    )
      return;

    const measurePower =
      power || -powerProduction! || -this.#prevPowerProduction!;
    this.log(`Set measure_power capability to`, measurePower);
    this.setCapabilityValue('measure_power', measurePower).catch(console.error);
    this.#prevUpdate = moment();

    if (measurePower !== this.#prevPower) {
      this.#prevPower = measurePower;
      this.log(`Trigger power changed`, measurePower.toFixed(9));
      this.#powerChangedTrigger
        .trigger(this, { power: measurePower })
        .catch(console.error);
    }

    const currentL1 = result.data?.liveMeasurement?.currentL1;
    if (currentL1 !== undefined && currentL1 !== null) {
      this.setCapabilityValue('measure_current.L1', currentL1).catch(
        console.error,
      );

      if (currentL1 !== this.#prevCurrentL1) {
        this.#prevCurrentL1 = currentL1!;
        this.log(`Trigger current L1 changed`, currentL1);
        this.#currentL1ChangedTrigger
          .trigger(this, { currentL1 })
          .catch(console.error);
      }
    }

    const currentL2 = result.data?.liveMeasurement?.currentL2;
    if (currentL2 !== undefined && currentL2 !== null) {
      this.setCapabilityValue('measure_current.L2', currentL2).catch(
        console.error,
      );

      if (currentL2 !== this.#prevCurrentL2) {
        this.#prevCurrentL2 = currentL2!;
        this.log(`Trigger current L2 changed`, currentL2);
        this.#currentL2ChangedTrigger
          .trigger(this, { currentL2 })
          .catch(console.error);
      }
    }

    const currentL3 = result.data?.liveMeasurement?.currentL3;
    if (currentL3 !== undefined && currentL3 !== null) {
      this.setCapabilityValue('measure_current.L3', currentL3).catch(
        console.error,
      );
      if (currentL3 !== this.#prevCurrentL3) {
        this.#prevCurrentL3 = currentL3!;
        this.log(`Trigger current L3 changed`, currentL3);
        this.#currentL3ChangedTrigger
          .trigger(this, { currentL3 })
          .catch(console.error);
      }
    }

    const consumption = result.data?.liveMeasurement?.accumulatedConsumption;
    if (consumption && _.isNumber(consumption)) {
      const fixedConsumption = Number(consumption.toFixed(2));
      if (fixedConsumption !== this.#prevConsumption) {
        if (fixedConsumption < this.#prevConsumption!) {
          // Consumption has been reset
          this.log('Triggering daily consumption report');
          this.#dailyConsumptionReportTrigger
            .trigger(this, {
              consumption: this.#prevConsumption,
              cost: this.#prevCost,
            })
            .catch(console.error);
        }

        this.#prevConsumption = fixedConsumption;
        this.setCapabilityValue('meter_power', fixedConsumption).catch(
          console.error,
        );
        this.#consumptionChangedTrigger
          .trigger(this, { consumption: fixedConsumption })
          .catch(console.error);
      }
    }

    let cost = result.data?.liveMeasurement?.accumulatedCost;
    if (cost === undefined || cost === null) {
      try {
        const now = moment();
        if (
          !this.#cachedNordpoolPrice ||
          this.#cachedNordpoolPrice.hour !== now.hour()
        ) {
          const area = this.#area || 'Oslo';
          const currency = this.#currency || 'NOK';
          this.log(
            `Using nordpool prices. Currency: ${currency} - Area: ${area}`,
          );
          const priceResult: NordpoolPriceResult = await http.json(
            `https://www.nordpoolgroup.com/api/marketdata/page/10?currency=${currency},${currency},${currency},${currency}&endDate=${moment().format(
              'DD-MM-YYYY',
            )}`,
          );
          const filteredRows = (priceResult.data.Rows ?? [])
            .filter(
              (row) =>
                !row.IsExtraRow &&
                moment.tz(row.StartTime, 'Europe/Oslo').isBefore(now) &&
                moment.tz(row.EndTime, 'Europe/Oslo').isAfter(now),
            )
            .map((row) => row.Columns);

          const areaCurrentPrice = filteredRows.length
            ? filteredRows[0].find((a: { Name: string }) => a.Name === area)
            : undefined;

          if (areaCurrentPrice !== undefined) {
            const currentPrice =
              Number(
                areaCurrentPrice.Value.replace(',', '.')
                  .replace(' ', '')
                  .trim(),
              ) / 1000;

            this.#cachedNordpoolPrice = {
              hour: now.hour(),
              price: currentPrice,
            };
            this.log(
              `Found price for ${now.format()} for area ${area} ${currentPrice}`,
            );
          }
        }

        if (_.isNumber(this.#cachedNordpoolPrice?.price))
          cost = this.#cachedNordpoolPrice!.price * consumption!;
      } catch (e) {
        console.error('Error fetching prices from nordpool', e);
      }
    }

    if (cost && _.isNumber(cost)) {
      const fixedCost = Number(cost.toFixed(2));
      if (fixedCost === this.#prevCost) return;

      this.#prevCost = fixedCost;
      this.setCapabilityValue('accumulatedCost', fixedCost).catch(
        console.error,
      );
      this.#costChangedTrigger
        .trigger(this, { cost: fixedCost })
        .catch(console.error);
    }
  }

  onDeleted() {
    if (
      this.#wsSubscription &&
      _.isFunction(this.#wsSubscription.unsubscribe)
    ) {
      try {
        this.log('Unsubscribing from previous connection');
        this.#wsSubscription.unsubscribe();
        this.#resubscribeDebounce.cancel();
      } catch (e) {
        this.log('Error unsubscribing from previous connection', e);
      }
    }
  }
}

module.exports = PulseDevice;
