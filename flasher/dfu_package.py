"""The DFU package: the .zip MeshCore publishes for each nRF52 board (adafruit-nrfutil's legacy
format, dfu_version 0.5): manifest.json, the init packet (firmware.dat) and the application image
(firmware.bin). Read here so the page gets checked parts, not a zip to unpack."""

import io
import json
import struct
import zipfile

# The ProMicro's application space: MeshCore boards/promicro_nrf52840.json, upload.maximum_size.
MAX_APP_SIZE = 815104
MAX_DAT_SIZE = 256
MAX_MANIFEST_SIZE = 64 * 1024


class PackageError(ValueError):
    pass


def crc16(data, crc=0xFFFF):
    """CRC-16/CCITT as nrfutil computes it (nordicsemi/dfu/crc16.py): the init packet's
    firmware_crc16 and the serial transport's packet check."""
    for b in data:
        crc = ((crc >> 8) & 0x00FF) | ((crc << 8) & 0xFF00)
        crc ^= b
        crc ^= (crc & 0x00FF) >> 4
        crc ^= (crc << 8) << 4
        crc ^= ((crc & 0x00FF) << 4) << 1
        crc &= 0xFFFF
    return crc


def parse_init_packet(dat):
    """The legacy init packet: device type, revision, application version, the SoftDevices it
    accepts, then the image's CRC-16 (nrfutil nordicsemi/dfu/init_packet.py, PacketField order)."""
    if len(dat) < 12:
        raise PackageError("init packet too short")
    device_type, device_rev, app_version, sd_count = struct.unpack_from("<HHIH", dat, 0)
    if len(dat) != 12 + 2 * sd_count:
        raise PackageError("init packet length doesn't match its SoftDevice list")
    sd_req = list(struct.unpack_from(f"<{sd_count}H", dat, 10))
    (firmware_crc16,) = struct.unpack_from("<H", dat, 10 + 2 * sd_count)
    return {
        "device_type": device_type,
        "device_revision": device_rev,
        "application_version": app_version,
        "softdevice_req": sd_req,
        "firmware_crc16": firmware_crc16,
    }


def parse(zip_bytes):
    """Returns {"init": bytes, "image": bytes, "initPacket": {...}} or raises PackageError."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as e:
        raise PackageError(f"not a zip: {e}") from e

    def read(name, limit):
        try:
            info = zf.getinfo(name)
        except KeyError as e:
            raise PackageError(f"{name} isn't in the package") from e
        if info.file_size > limit:
            raise PackageError(f"{name} is {info.file_size} bytes, more than {limit}")
        data = zf.read(info)
        if len(data) != info.file_size:
            raise PackageError(f"{name} didn't unpack to its stated size")
        return data

    try:
        manifest = json.loads(read("manifest.json", MAX_MANIFEST_SIZE))["manifest"]
    except (ValueError, KeyError, TypeError) as e:
        raise PackageError(f"manifest.json unreadable: {e}") from e

    # Only an application: a SoftDevice or bootloader update is not this tool's job.
    extra = sorted(set(manifest) - {"application", "dfu_version"})
    if extra:
        raise PackageError(f"the package updates more than the application: {', '.join(extra)}")
    app = manifest.get("application")
    if not isinstance(app, dict) or not isinstance(app.get("bin_file"), str) or not isinstance(app.get("dat_file"), str):
        raise PackageError("manifest.json has no application image")
    if manifest.get("dfu_version") != 0.5:
        raise PackageError(f"dfu_version {manifest.get('dfu_version')!r}: only the legacy 0.5 format is supported")

    image = read(app["bin_file"], MAX_APP_SIZE)
    init = read(app["dat_file"], MAX_DAT_SIZE)
    if not image:
        raise PackageError("the application image is empty")
    packet = parse_init_packet(init)
    actual = crc16(image)
    if packet["firmware_crc16"] != actual:
        raise PackageError(f"image CRC {actual:#06x} doesn't match the init packet's {packet['firmware_crc16']:#06x}")
    stated = app.get("init_packet_data", {}).get("firmware_crc16")
    if stated is not None and stated != actual:
        raise PackageError("image CRC doesn't match manifest.json")
    return {"init": init, "image": image, "initPacket": packet}
